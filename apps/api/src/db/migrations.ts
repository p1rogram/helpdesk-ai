/**
 * AI: Список миграций схемы. Правило одно: уже применённый шаг не редактируют - добавляют новый в
 * конец с следующим номером. Каждый шаг выполняется в транзакции, id записывается в
 * schema_migrations (см. ensureSchema в client.ts). Выражения идемпотентны (IF NOT EXISTS), чтобы
 * базы, созданные до появления журнала миграций, прошли первый запуск без конфликтов.
 */
export interface Migration {
  id: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    // AI: Базовая схема хакатона: каталог, пользователи, обращения, сообщения, корпус RAG, статистика.
    id: '0001_base',
    statements: [
      `CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      sphere TEXT NOT NULL,
      organisation TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'ru',
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
      `CREATE TABLE IF NOT EXISTS categories (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      clarify JSONB NOT NULL DEFAULT '[]'::jsonb,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, id)
    )`,
      `CREATE TABLE IF NOT EXISTS kb_articles (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      title TEXT NOT NULL,
      symptoms TEXT NOT NULL,
      steps JSONB NOT NULL,
      not_applicable_when TEXT,
      escalate_after BOOLEAN NOT NULL DEFAULT false,
      audience TEXT NOT NULL DEFAULT 'internal',
      source TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, id)
    )`,
      `CREATE INDEX IF NOT EXISTS kb_tenant_cat ON kb_articles(tenant_id, category_id)`,
      `CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      platform TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS users_platform_uid ON users(platform, platform_user_id)`,
      `CREATE TABLE IF NOT EXISTS tickets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      user_id UUID NOT NULL REFERENCES users(id),
      state TEXT NOT NULL DEFAULT 'intake',
      category_id TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      confidence REAL,
      summary TEXT,
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      tone TEXT NOT NULL DEFAULT 'neutral',
      clarifications_asked INTEGER NOT NULL DEFAULT 0,
      pending_field TEXT,
      article_id TEXT,
      tried_articles JSONB NOT NULL DEFAULT '[]'::jsonb,
      resolved BOOLEAN NOT NULL DEFAULT false,
      escalated BOOLEAN NOT NULL DEFAULT false,
      escalation_reason TEXT,
      handled_by TEXT NOT NULL DEFAULT 'ai',
      escalation_blocked BOOLEAN NOT NULL DEFAULT false,
      external_id TEXT,
      external_url TEXT,
      pending_escalation TEXT,
      rating INTEGER,
      rating_comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at TIMESTAMPTZ
    )`,
      `CREATE INDEX IF NOT EXISTS tickets_user_created ON tickets(user_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id UUID NOT NULL REFERENCES tickets(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
      `CREATE INDEX IF NOT EXISTS messages_ticket_created ON messages(ticket_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS rag_chunks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL,
      title TEXT NOT NULL,
      section TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT 'internal',
      content_hash TEXT NOT NULL,
      embedding JSONB,
      embedding_model TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
      `CREATE INDEX IF NOT EXISTS rag_chunks_tenant ON rag_chunks(tenant_id)`,
      `CREATE TABLE IF NOT EXISTS daily_stats (
      day TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      created INTEGER NOT NULL DEFAULT 0,
      resolved INTEGER NOT NULL DEFAULT 0,
      escalated INTEGER NOT NULL DEFAULT 0,
      rating_sum INTEGER NOT NULL DEFAULT 0,
      rating_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, tenant_id, category_id)
    )`,
    ],
  },
  {
    // AI: Связь с внешним хелпдеском (help.tpu.ru) и блокировка эскалации.
    id: '0002_helpdesk_link',
    statements: [
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_id TEXT',
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS external_url TEXT',
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pending_escalation TEXT',
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS handled_by TEXT NOT NULL DEFAULT 'ai'",
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalation_blocked BOOLEAN NOT NULL DEFAULT false',
    ],
  },
  {
    // AI: Публичные статьи для гостей и хэш каталога для пересева.
    id: '0003_kb_audience_seed_hash',
    statements: [
      "ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'internal'",
      'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS seed_hash TEXT',
    ],
  },
  {
    // AI: Диалог v2: несколько проблем в одном сообщении, список уточнений, маршрут эскалации,
    // дневные лимиты пользователя.
    id: '0004_dialog_v2',
    statements: [
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_by TEXT',
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS busy_until TIMESTAMPTZ',
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pending_problems JSONB NOT NULL DEFAULT '[]'",
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pending_fields JSONB NOT NULL DEFAULT '[]'",
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated_to TEXT',
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS complex BOOLEAN NOT NULL DEFAULT false',
      "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'problem'",
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS human_insisted BOOLEAN NOT NULL DEFAULT false',
      "ALTER TABLE categories ADD COLUMN IF NOT EXISTS escalation TEXT NOT NULL DEFAULT 'operator'",
      `CREATE TABLE IF NOT EXISTS daily_user_counters (
      user_id UUID NOT NULL REFERENCES users(id),
      day TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      human_calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    )`,
    ],
  },
  {
    // AI: Кэш ответов на повторяющиеся вопросы.
    id: '0005_answer_cache',
    statements: [
      `CREATE TABLE IF NOT EXISTS answer_cache (
      key TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      sources JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    ],
  },
  {
    // AI: Консоль оператора: назначение, заметки, отметка «прочитано», кто закрыл.
    id: '0006_operator_console',
    statements: [
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_to TEXT',
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_to_id TEXT',
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS operator_notes TEXT',
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS operator_read_at TIMESTAMPTZ',
      'ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_by_name TEXT',
      'CREATE INDEX IF NOT EXISTS tickets_tenant_state ON tickets(tenant_id, state)',
    ],
  },
  {
    // AI: Общий счётчик rate-limit для нескольких реплик API (см. plugins/rate-limit-store.ts).
    id: '0007_rate_limits',
    statements: [
      `CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS rate_limits_expires ON rate_limits(expires_at)',
    ],
  },
];
