import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** AI: Корень репозитория (работает и из src/ через tsx, и из dist/ после сборки). */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/**
 * AI: Вся конфигурация проверяется один раз при старте. Опечатка в .env валит процесс сразу с
 * понятным сообщением, а не даёт 500 в три часа ночи на демо.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  ANTHROPIC_API_KEY: z.string().optional(),
  /**
   * AI: По умолчанию прямой Anthropic API; при необходимости укажите адрес агрегатора/прокси
   * (формат Anthropic Messages).
   */
  LLM_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  LLM_MODEL: z.string().default('claude-opus-5'),
  LLM_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  /**
   * AI: Таймаут одного запроса; одна повторная попытка. Худший случай до детерминированного
   * запасного режима = 2x этого значения.
   */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /**
   * AI: Альтернативный адрес Bot API. Хостинг в России не достаёт до api.telegram.org напрямую;
   * крошечный Cloudflare Worker (deploy/telegram-proxy.worker.js) пробрасывает запросы. Та же идея,
   * что LLM_BASE_URL для модели.
   */
  TELEGRAM_API_ROOT: z.string().url().optional(),
  /** AI: Публичный username бота (без @) - для ссылки «Открыть в Telegram» на сайте. */
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  /** AI: VK Mini Apps: секретный ключ и id приложения с dev.vk.com (включает /api/auth/vk). */
  VK_APP_SECRET: z.string().optional(),
  VK_APP_ID: z.string().optional(),
  /** AI: MAX Mini Apps: токен бота из консоли разработчика MAX (включает /api/auth/max). */
  MAX_BOT_TOKEN: z.string().optional(),
  MAX_SECRET_LABEL: z.string().default('WebAppData'),

  // ----- Корпоративная идентификация (любое подмножество; каждый провайдер включает свои маршруты) -----
  /** AI: SSO по OpenID Connect: URL issuer (realm Keycloak / ADFS / и т. п.). */
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_SCOPES: z.string().default('openid profile email'),
  OIDC_CLAIM_ID: z.string().default('preferred_username'),
  OIDC_CLAIM_NAME: z.string().default('name'),
  OIDC_CLAIM_EMAIL: z.string().default('email'),
  OIDC_CLAIM_GROUPS: z.string().default('groups'),
  SSO_LABEL: z.string().default('Войти через учётную запись ТПУ'),
  /** AI: Bind к LDAP / Active Directory. */
  LDAP_URL: z.string().optional(),
  LDAP_BIND_TEMPLATE: z.string().default('{login}@tpu.ru'),
  LDAP_BASE_DN: z.string().optional(),
  LDAP_SEARCH_FILTER: z.string().default('(sAMAccountName={login})'),
  LDAP_ATTR_NAME: z.string().default('displayName'),
  LDAP_ATTR_EMAIL: z.string().default('mail'),
  LDAP_ATTR_GROUPS: z.string().default('memberOf'),
  LDAP_TLS_REJECT_UNAUTHORIZED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  /** AI: Одноразовый код на корпоративную почту. */
  EMAIL_AUTH_DOMAINS: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('helpdesk-bot@tpu.ru'),
  /** AI: Группы организации (DN или CN), участники которых получают консоль оператора. */
  OPERATOR_GROUPS: z.string().default(''),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_TTL: z.string().default('12h'),
  WEB_APP_URL: z.string().url().optional(),
  /**
   * AI: Входы на сайте. Гостевой вход анонимный (только публичные темы, без заявок и оператора) и
   * безопасен везде. Демо-вход пускает любого «студентом» по введённому имени - только для демо и
   * тестов команды; в production разрешён, но с громким предупреждением в логе; настоящий вход для
   * сотрудников организации - SSO / LDAP / код на почту.
   */
  WEB_GUEST_LOGIN: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  WEB_DEMO_LOGIN: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('./data/pglite'),

  EVENT_BUS: z.enum(['memory', 'kafka']).default('memory'),
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('helpdesk-api'),

  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(90),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(16_384),

  /** AI: Каталог с *.json-сидами; каждый файл импортируется как тенант, если его ещё нет в БД. */
  CATALOG_SEED_DIR: z.string().default('./data/catalog'),
  DEFAULT_TENANT: z.string().default('tpu'),
  /**
   * AI: Переимпортировать сиды при каждом старте (dev: правишь JSON, перезапускаешь). В проде -
   * через admin API.
   */
  CATALOG_SEED_FORCE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /** AI: Внешний helpdesk: none (dev) | naumen (help.tpu.ru). */
  HELPDESK_KIND: z.enum(['none', 'naumen']).default('none'),
  NAUMEN_URL: z.string().url().optional(),
  NAUMEN_ACCESS_KEY: z.string().optional(),
  NAUMEN_DEFAULT_SERVICE: z.string().optional(),
  /** AI: JSON-объект: { "network": "slmService$4550406", ... } */
  NAUMEN_SERVICE_BY_CATEGORY: z.string().optional(),
  /**
   * AI: Демо-режим: консоль оператора получает каждый вошедший пользователь. Только для демо
   * хакатона и тестов команды - в NODE_ENV=production запрещён.
   */
  OPERATOR_OPEN_ACCESS: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /**
   * AI: Id администраторов через запятую (platform:platformUserId), которым доступен /api/admin/*.
   */
  ADMIN_USERS: z.string().default(''),
  /** AI: RAG по скачанной документации (data/raw). Off = только проверенный каталог. */
  RAG_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  /** AI: local = ONNX-модель внутри процесса API (без внешних вызовов); off = только BM25. */
  RAG_EMBEDDINGS: z.enum(['local', 'off']).default('local'),
  RAG_EMBEDDING_MODEL: z.string().default('Xenova/multilingual-e5-small'),
  RAG_RAW_DIR: z.string().default('./data/raw'),
  RAG_MODEL_DIR: z.string().default('./data/models'),
  /**
   * AI: Перечитывать data/raw при старте (dev). В проде индексировать через POST
   * /api/admin/rag/ingest.
   */
  RAG_INGEST_ON_BOOT: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  MAX_CLARIFICATIONS: z.coerce.number().int().min(0).max(5).default(2),
  /**
   * AI: Дневные лимиты на пользователя (операторов не касаются): сколько заявок специалисту можно
   * создать и сколько раз позвать человека. Сверх лимита помощник продолжает решать по базе знаний.
   */
  DAILY_REQUEST_LIMIT: z.coerce.number().int().min(0).default(4),
  DAILY_HUMAN_LIMIT: z.coerce.number().int().min(0).default(3),
  CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  HISTORY_TURNS: z.coerce.number().int().min(2).max(40).default(12),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  corsOrigins: string[];
  adminUsers: Set<string>;
  operatorGroups: Set<string>;
  llmEnabled: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // AI: Пустое значение в .env (`OIDC_ISSUER=` или `OIDC_ISSUER=    # комментарий`) означает «не
  // задано», а не пустой URL. docker compose оставляет пробелы перед строчным комментарием, Node -
  // нет.
  const defined = Object.fromEntries(
    Object.entries(env)
      .map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v] as const)
      .filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = EnvSchema.safeParse(defined);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && cfg.OPERATOR_OPEN_ACCESS) {
    throw new Error('OPERATOR_OPEN_ACCESS must be false in production');
  }
  return {
    ...cfg,
    PGLITE_DIR: path.resolve(REPO_ROOT, cfg.PGLITE_DIR),
    CATALOG_SEED_DIR: path.resolve(REPO_ROOT, cfg.CATALOG_SEED_DIR),
    RAG_RAW_DIR: path.resolve(REPO_ROOT, cfg.RAG_RAW_DIR),
    RAG_MODEL_DIR: path.resolve(REPO_ROOT, cfg.RAG_MODEL_DIR),
    corsOrigins: cfg.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adminUsers: new Set(
      cfg.ADMIN_USERS.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    operatorGroups: new Set(
      cfg.OPERATOR_GROUPS.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    llmEnabled: Boolean(cfg.ANTHROPIC_API_KEY),
  };
}
