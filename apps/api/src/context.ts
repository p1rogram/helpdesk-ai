import type { FastifyBaseLogger } from 'fastify';
import { TOPICS } from '@helpdesk/shared';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import { connectDb, ensureSchema, type DbHandle } from './db/client.js';
import {
  devVerifier,
  maxVerifier,
  telegramVerifier,
  vkVerifier,
  type PlatformVerifier,
} from './modules/auth/index.js';
import { DialogEngine } from './modules/dialog/engine.js';
import { createEventBus, type EventBus } from './modules/events/index.js';
import { attachDevTelegramNotifier } from './modules/events/dev-notifier.js';
import { CatalogRepository, KnowledgeService } from './modules/knowledge/index.js';
import { LlmService } from './modules/llm/index.js';
import { TicketRepository } from './modules/tickets/repository.js';
import { NaumenHelpdesk, NoopHelpdesk, type HelpdeskConnector } from './modules/helpdesk/index.js';
import { EmailCodeProvider, LdapProvider, OidcProvider } from './modules/auth/corporate.js';
import { OperatorHub } from './modules/operator/hub.js';
import { LocalEmbedder, NullEmbedder, RagService } from './modules/rag/index.js';
import type { FastifyInstance } from 'fastify';

/** AI: Composition root: every dependency is built once here and injected explicitly. */
export interface AppContext {
  config: AppConfig;
  dbHandle: DbHandle;
  events: EventBus;
  catalogs: CatalogRepository;
  knowledge: KnowledgeService;
  rag: RagService;
  llm: LlmService;
  tickets: TicketRepository;
  engine: DialogEngine;
  verifiers: Map<string, PlatformVerifier>;
  helpdesk: HelpdeskConnector;
  operatorHub: OperatorHub;
  corporate: {
    oidc: OidcProvider | null;
    ldap: LdapProvider | null;
    email: EmailCodeProvider | null;
  };
  /** AI: Set by buildApp - needed to sign tokens from route modules. */
  app: FastifyInstance;
  close(): Promise<void>;
}

export async function buildContext(config: AppConfig, log: FastifyBaseLogger): Promise<AppContext> {
  const dbHandle = await connectDb({ url: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR });
  await ensureSchema(dbHandle.db);
  log.info(`database: ${dbHandle.kind}`);

  const events = await createEventBus({
    kind: config.EVENT_BUS,
    brokers: config.KAFKA_BROKERS,
    clientId: config.KAFKA_CLIENT_ID,
    log: { info: (m) => log.info(m), error: (o, m) => log.error(o as object, m) },
  });

  if (config.EVENT_BUS === 'memory' && config.TELEGRAM_BOT_TOKEN) {
    await attachDevTelegramNotifier(events, config.TELEGRAM_BOT_TOKEN, {
      info: (o, m) => log.info(o as object, m),
      warn: (o, m) => log.warn(o as object, m),
    });
  }

  const catalogs = new CatalogRepository(dbHandle.db);
  await catalogs.seedFromDir(
    config.CATALOG_SEED_DIR,
    { info: (m) => log.info(m) },
    config.CATALOG_SEED_FORCE,
  );
  const knowledge = new KnowledgeService(catalogs);

  // AI: RAG corpus: crawled documentation, chunked + embedded locally. Ingest runs in the background
  // so the API answers from the catalog immediately; RAG joins as soon as the index is ready.
  const embedder =
    config.RAG_ENABLED && config.RAG_EMBEDDINGS === 'local'
      ? new LocalEmbedder({
          model: config.RAG_EMBEDDING_MODEL,
          cacheDir: config.RAG_MODEL_DIR,
          log: { info: (m) => log.info(m) },
        })
      : new NullEmbedder();
  const rag = new RagService(dbHandle.db, embedder, {
    info: (m) => log.info(m),
    warn: (m) => log.warn(m),
  });
  if (config.RAG_ENABLED) {
    // AI: In the background: the API answers /health at once; ingest (when enabled) and then the
    // warm-up (model load + index build) happen before the first user asks anything.
    void (async () => {
      await rag.prepareStorage();
      if (config.RAG_INGEST_ON_BOOT) {
        const started = Date.now();
        const docs = await rag.loadRawDir(config.RAG_RAW_DIR);
        if (!docs.length) log.info(`rag: no raw documents in ${config.RAG_RAW_DIR}`);
        else {
          const res = await rag.ingest(config.DEFAULT_TENANT, docs);
          log.info(
            `rag: ${docs.length} documents -> ${res.chunks} chunks (${res.embedded} newly embedded) in ${Date.now() - started} ms`,
          );
        }
      }
      const started = Date.now();
      await rag.warmup(config.DEFAULT_TENANT);
      log.info(`rag: warm-up done in ${Date.now() - started} ms`);
    })().catch((err) => log.warn(err, 'rag ingest failed'));
  }
  log.info(`rag: ${config.RAG_ENABLED ? `enabled, embeddings=${embedder.model}` : 'disabled'}`);

  const llm = new LlmService({
    apiKey: config.ANTHROPIC_API_KEY,
    baseURL: config.LLM_BASE_URL,
    model: config.LLM_MODEL,
    effort: config.LLM_EFFORT,
    timeoutMs: config.LLM_TIMEOUT_MS,
    log: { warn: (o, m) => log.warn(o as object, m), debug: (o, m) => log.debug(o as object, m) },
    onUsage: (u) => {
      void events
        .publish(TOPICS.llmUsage, 'usage', {
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          ticketId: '',
          ...u,
        })
        .catch((err) => log.warn(err, 'failed to publish llm usage'));
    },
  });
  log.info(
    `llm: ${llm.enabled ? `${config.LLM_MODEL} (effort=${config.LLM_EFFORT}) via ${config.LLM_BASE_URL}` : 'DISABLED - deterministic fallback mode'}`,
  );

  const tickets = new TicketRepository(dbHandle.db);

  // AI: Live channel for operator consoles, fed by the event bus (works across API replicas on Kafka).
  const operatorHub = new OperatorHub();
  await operatorHub.attach(
    events,
    async (ticketId) => (await tickets.getAny(ticketId))?.tenantId ?? null,
  );

  let helpdesk: HelpdeskConnector = new NoopHelpdesk();
  if (config.HELPDESK_KIND === 'naumen') {
    if (!config.NAUMEN_URL || !config.NAUMEN_ACCESS_KEY || !config.NAUMEN_DEFAULT_SERVICE) {
      throw new Error(
        'HELPDESK_KIND=naumen requires NAUMEN_URL, NAUMEN_ACCESS_KEY, NAUMEN_DEFAULT_SERVICE',
      );
    }
    helpdesk = new NaumenHelpdesk({
      baseUrl: config.NAUMEN_URL,
      accessKey: config.NAUMEN_ACCESS_KEY,
      defaultServiceId: config.NAUMEN_DEFAULT_SERVICE,
      serviceByCategory: config.NAUMEN_SERVICE_BY_CATEGORY
        ? (JSON.parse(config.NAUMEN_SERVICE_BY_CATEGORY) as Record<string, string>)
        : undefined,
    });
  }
  log.info(`helpdesk connector: ${helpdesk.kind}`);

  const engine = new DialogEngine({
    knowledge,
    rag: config.RAG_ENABLED ? rag : null,
    llm,
    tickets,
    events,
    helpdesk,
    config: {
      maxClarifications: config.MAX_CLARIFICATIONS,
      confidenceThreshold: config.CONFIDENCE_THRESHOLD,
      historyTurns: config.HISTORY_TURNS,
    },
    log: { info: (o, m) => log.info(o as object, m), warn: (o, m) => log.warn(o as object, m) },
  });

  const verifiers = new Map<string, PlatformVerifier>();
  if (config.TELEGRAM_BOT_TOKEN)
    verifiers.set('telegram', telegramVerifier(config.TELEGRAM_BOT_TOKEN));
  if (config.VK_APP_SECRET) verifiers.set('vk', vkVerifier(config.VK_APP_SECRET, config.VK_APP_ID));
  if (config.MAX_BOT_TOKEN)
    verifiers.set('max', maxVerifier(config.MAX_BOT_TOKEN, config.MAX_SECRET_LABEL));
  if (config.WEB_GUEST_LOGIN || config.WEB_DEMO_LOGIN) verifiers.set('web', devVerifier());
  if (config.WEB_DEMO_LOGIN && config.NODE_ENV === 'production')
    log.warn(
      'WEB_DEMO_LOGIN=true - anyone can enter the website as a student without verification',
    );
  log.info(`auth platforms: ${[...verifiers.keys()].join(', ') || 'none'}`);
  if (config.OPERATOR_OPEN_ACCESS)
    log.warn('OPERATOR_OPEN_ACCESS=true - the operator console is open to every user (demo mode)');

  const corporate = {
    oidc:
      config.OIDC_ISSUER && config.OIDC_CLIENT_ID && config.OIDC_REDIRECT_URI
        ? new OidcProvider({
            issuer: config.OIDC_ISSUER,
            clientId: config.OIDC_CLIENT_ID,
            clientSecret: config.OIDC_CLIENT_SECRET,
            redirectUri: config.OIDC_REDIRECT_URI,
            scopes: config.OIDC_SCOPES,
            claims: {
              id: config.OIDC_CLAIM_ID,
              name: config.OIDC_CLAIM_NAME,
              email: config.OIDC_CLAIM_EMAIL,
              groups: config.OIDC_CLAIM_GROUPS,
            },
          })
        : null,
    ldap:
      config.LDAP_URL && config.LDAP_BASE_DN
        ? new LdapProvider({
            url: config.LDAP_URL,
            bindTemplate: config.LDAP_BIND_TEMPLATE,
            baseDn: config.LDAP_BASE_DN,
            searchFilter: config.LDAP_SEARCH_FILTER,
            attributes: {
              name: config.LDAP_ATTR_NAME,
              email: config.LDAP_ATTR_EMAIL,
              groups: config.LDAP_ATTR_GROUPS,
            },
            tlsRejectUnauthorized: config.LDAP_TLS_REJECT_UNAUTHORIZED,
          })
        : null,
    email:
      config.EMAIL_AUTH_DOMAINS && config.SMTP_HOST
        ? new EmailCodeProvider({
            domains: config.EMAIL_AUTH_DOMAINS.split(',').map((s) => s.trim().toLowerCase()),
            smtp: {
              host: config.SMTP_HOST,
              port: config.SMTP_PORT,
              secure: config.SMTP_SECURE,
              user: config.SMTP_USER,
              pass: config.SMTP_PASS,
              from: config.SMTP_FROM,
            },
          })
        : null,
  };
  log.info(
    `corporate auth: ${[corporate.oidc && 'oidc', corporate.ldap && 'ldap', corporate.email && 'email'].filter(Boolean).join(', ') || 'none (socket ready)'}`,
  );

  return {
    config,
    dbHandle,
    events,
    catalogs,
    knowledge,
    rag,
    llm,
    tickets,
    engine,
    verifiers,
    helpdesk,
    operatorHub,
    corporate,
    app: null as unknown as FastifyInstance,
    async close() {
      await events.close();
      await dbHandle.close();
    },
  };
}
