import type { FastifyBaseLogger } from 'fastify';
import { TOPICS } from '@helpdesk/shared';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import { connectDb, ensureSchema, type DbHandle } from './db/client.js';
import { devVerifier, telegramVerifier, type PlatformVerifier } from './modules/auth/index.js';
import { DialogEngine } from './modules/dialog/engine.js';
import { createEventBus, type EventBus } from './modules/events/index.js';
import { attachDevTelegramNotifier } from './modules/events/dev-notifier.js';
import { CatalogRepository, KnowledgeService } from './modules/knowledge/index.js';
import { LlmService } from './modules/llm/index.js';
import { TicketRepository } from './modules/tickets/repository.js';

/** Composition root: every dependency is built once here and injected explicitly. */
export interface AppContext {
  config: AppConfig;
  dbHandle: DbHandle;
  events: EventBus;
  catalogs: CatalogRepository;
  knowledge: KnowledgeService;
  llm: LlmService;
  tickets: TicketRepository;
  engine: DialogEngine;
  verifiers: Map<string, PlatformVerifier>;
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
  await catalogs.seedFromDir(config.CATALOG_SEED_DIR, { info: (m) => log.info(m) }, config.CATALOG_SEED_FORCE);
  const knowledge = new KnowledgeService(catalogs);

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
  log.info(`llm: ${llm.enabled ? `${config.LLM_MODEL} (effort=${config.LLM_EFFORT}) via ${config.LLM_BASE_URL}` : 'DISABLED - deterministic fallback mode'}`);

  const tickets = new TicketRepository(dbHandle.db);
  const engine = new DialogEngine({
    knowledge,
    llm,
    tickets,
    events,
    config: {
      maxClarifications: config.MAX_CLARIFICATIONS,
      confidenceThreshold: config.CONFIDENCE_THRESHOLD,
      historyTurns: config.HISTORY_TURNS,
    },
    log: { info: (o, m) => log.info(o as object, m), warn: (o, m) => log.warn(o as object, m) },
  });

  const verifiers = new Map<string, PlatformVerifier>();
  if (config.TELEGRAM_BOT_TOKEN) verifiers.set('telegram', telegramVerifier(config.TELEGRAM_BOT_TOKEN));
  if (config.AUTH_DEV_BYPASS) verifiers.set('web', devVerifier());
  log.info(`auth platforms: ${[...verifiers.keys()].join(', ') || 'none'}`);

  return {
    config,
    dbHandle,
    events,
    catalogs,
    knowledge,
    llm,
    tickets,
    engine,
    verifiers,
    async close() {
      await events.close();
      await dbHandle.close();
    },
  };
}
