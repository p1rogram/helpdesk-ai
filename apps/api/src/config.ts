import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Repo root (works from src/ via tsx and from dist/ after build). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * All runtime configuration is validated once at boot. A typo in .env fails fast
 * with a readable message instead of a 500 at 3 a.m. during the demo.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  ANTHROPIC_API_KEY: z.string().optional(),
  /** Direct Anthropic API by default; set to an aggregator/proxy origin (Anthropic Messages format) if needed. */
  LLM_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  LLM_MODEL: z.string().default('claude-opus-5'),
  LLM_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  /** Per-request timeout; one retry. Worst case before the deterministic fallback = 2x this value. */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /** Public bot username (without @) - used for the "Open in Telegram" link on the website. */
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  /** VK Mini Apps: secret key + app id from dev.vk.com (enables /api/auth/vk). */
  VK_APP_SECRET: z.string().optional(),
  VK_APP_ID: z.string().optional(),
  /** MAX Mini Apps: bot token from the MAX developer console (enables /api/auth/max). */
  MAX_BOT_TOKEN: z.string().optional(),
  MAX_SECRET_LABEL: z.string().default('WebAppData'),

  // ----- Corporate identity (any subset; each enables its own routes) -----
  /** OpenID Connect SSO: issuer URL (Keycloak realm / ADFS / etc.). */
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
  /** LDAP / Active Directory bind. */
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
  /** One-time code to a corporate mailbox. */
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
  /** Organisation groups (DN or CN) whose members get the operator console. */
  OPERATOR_GROUPS: z.string().default(''),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_TTL: z.string().default('12h'),
  WEB_APP_URL: z.string().url().optional(),
  AUTH_DEV_BYPASS: z
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

  /** Directory with *.json seeds; each file is imported as a tenant if not present in DB. */
  CATALOG_SEED_DIR: z.string().default('./data/catalog'),
  DEFAULT_TENANT: z.string().default('tpu'),
  /** Re-import seed files on every boot (dev: edit JSON, restart). In prod use the admin API. */
  CATALOG_SEED_FORCE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /** External helpdesk: none (dev) | naumen (help.tpu.ru). */
  HELPDESK_KIND: z.enum(['none', 'naumen']).default('none'),
  NAUMEN_URL: z.string().url().optional(),
  NAUMEN_ACCESS_KEY: z.string().optional(),
  NAUMEN_DEFAULT_SERVICE: z.string().optional(),
  /** JSON object: { "network": "slmService$4550406", ... } */
  NAUMEN_SERVICE_BY_CATEGORY: z.string().optional(),
  /** Comma-separated admin user ids (platform:platformUserId) allowed to call /api/admin/*. */
  ADMIN_USERS: z.string().default(''),
  MAX_CLARIFICATIONS: z.coerce.number().int().min(0).max(5).default(2),
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
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && cfg.AUTH_DEV_BYPASS) {
    throw new Error('AUTH_DEV_BYPASS must be false in production');
  }
  return {
    ...cfg,
    PGLITE_DIR: path.resolve(REPO_ROOT, cfg.PGLITE_DIR),
    CATALOG_SEED_DIR: path.resolve(REPO_ROOT, cfg.CATALOG_SEED_DIR),
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
