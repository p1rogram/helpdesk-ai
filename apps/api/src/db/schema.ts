import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ClarifyingField } from '@helpdesk/shared';

/**
 * AI: Схема Drizzle. Каждый запрос идёт через query builder -> параметризованный SQL, так что
 * SQL-инъекция невозможна по построению (нигде нет склейки строк).
 *
 * Мультитенантность: тенант - это «сфера» (ТПУ, корпоративное IT, провайдер...). Строки каталога и
 * тикеты несут tenant_id, поэтому одна установка обслуживает несколько сфер бок о бок.
 */

// ---------- Каталог (редактируется в рантайме через admin API, сидится из data/catalog/*.json) ----------

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(), // "tpu", "it-support"
  sphere: text('sphere').notNull(),
  organisation: text('organisation').notNull(),
  language: text('language').notNull().default('ru'),
  /**
   * AI: Увеличивается при каждом изменении каталога - для инвалидации кэша и ключей prompt cache.
   */
  version: integer('version').notNull().default(1),
  /**
   * AI: sha1 сид-файла, из которого тенант импортирован в последний раз; изменённый файл
   * импортируется заново.
   */
  seedHash: text('seed_hash'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const categories = pgTable(
  'categories',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    priority: text('priority').notNull().default('normal'),
    /** AI: 'helpdesk' | 'operator' - куда уходит заявка по этой категории. */
    escalation: text('escalation').notNull().default('operator'),
    clarify: jsonb('clarify').$type<ClarifyingField[]>().notNull().default([]),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
);

export const kbArticles = pgTable(
  'kb_articles',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    categoryId: text('category_id').notNull(),
    title: text('title').notNull(),
    symptoms: text('symptoms').notNull(),
    steps: jsonb('steps').$type<string[]>().notNull(),
    notApplicableWhen: text('not_applicable_when'),
    escalateAfter: boolean('escalate_after').notNull().default(false),
    audience: text('audience').notNull().default('internal'),
    source: text('source'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('kb_tenant_cat').on(t.tenantId, t.categoryId),
  ],
);

// ---------- Корпус RAG (скачанная документация, нарезанная и векторизованная) ----------

export const ragChunks = pgTable(
  'rag_chunks',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sourceUrl: text('source_url').notNull(),
    title: text('title').notNull(),
    section: text('section').notNull().default(''),
    content: text('content').notNull(),
    audience: text('audience').notNull().default('internal'),
    /**
     * AI: sha1 содержимого - неизменённые фрагменты не пересчитываются при повторной индексации.
     */
    contentHash: text('content_hash').notNull(),
    embedding: jsonb('embedding').$type<number[]>(),
    embeddingModel: text('embedding_model'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rag_chunks_tenant').on(t.tenantId)],
);

// ---------- Пользователи / тикеты / сообщения ----------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: text('platform').notNull(), // telegram | vk | max | web
    platformUserId: text('platform_user_id').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_platform_uid').on(t.platform, t.platformUserId)],
);

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    state: text('state').notNull().default('intake'),
    categoryId: text('category_id'),
    priority: text('priority').notNull().default('normal'),
    confidence: real('confidence'),
    summary: text('summary'),
    fields: jsonb('fields').$type<Record<string, string>>().notNull().default({}),
    tone: text('tone').notNull().default('neutral'),
    clarificationsAsked: integer('clarifications_asked').notNull().default(0),
    /** AI: Поле уточнения, о котором был последний вопрос (ответ ложится в этот ключ). */
    pendingField: text('pending_field'),
    /** AI: Все поля, которые спросили одним сообщением и ещё ждут ответа (ids). */
    pendingFields: jsonb('pending_fields').$type<string[]>().notNull().default([]),
    /** AI: Текущая статья, показанная пользователю. */
    articleId: text('article_id'),
    /** AI: Статьи, которые уже пробовали и отвергли («не помогло»). */
    triedArticles: jsonb('tried_articles').$type<string[]>().notNull().default([]),
    resolved: boolean('resolved').notNull().default(false),
    escalated: boolean('escalated').notNull().default(false),
    escalationReason: text('escalation_reason'),
    /** AI: 'operator' | 'helpdesk' - кому ушла заявка. */
    escalatedTo: text('escalated_to'),
    /** AI: Оценка модели: проблема комплексная - к живому специалисту, не в сервис-деск. */
    complex: boolean('complex').notNull().default(false),
    /** AI: 'problem' | 'question' - справочным вопросам специалист не предлагается. */
    kind: text('kind').notNull().default('problem'),
    /** AI: По справочному вопросу человека уже просили один раз - второй раз передаём. */
    humanInsisted: boolean('human_insisted').notNull().default(false),
    /** AI: 'ai' | 'operator' - пока 'operator', помощник в этом тикете не отвечает. */
    handledBy: text('handled_by').notNull().default('ai'),
    /** AI: Оператор вернул тикет помощнику и запретил повторную передачу. */
    escalationBlocked: boolean('escalation_blocked').notNull().default(false),
    /** AI: Номер / ссылка заявки во внешнем helpdesk после передачи. */
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    /** AI: Почему помощник предложил передачу (хранится, пока пользователь решает). */
    pendingEscalation: text('pending_escalation'),
    rating: integer('rating'),
    ratingComment: text('rating_comment'),
    /** AI: 'assistant' | 'operator' | 'user' - ставится вместе с closed_at. */
    closedBy: text('closed_by'),
    /** AI: Остальные проблемы из сообщения с несколькими: каждая станет своим обращением. */
    pendingProblems: jsonb('pending_problems').$type<string[]>().notNull().default([]),
    /**
     * AI: Аренда обработки тикета: один проход движка за раз, в том числе между репликами API.
     * Упавший процесс не блокирует тикет - аренда истекает сама.
     */
    busyUntil: timestamp('busy_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('tickets_user_created').on(t.userId, t.createdAt)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    role: text('role').notNull(), // user | assistant | system
    content: text('content').notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_ticket_created').on(t.ticketId, t.createdAt)],
);

/** AI: Дневные счётчики пользователя: заявки специалисту и просьбы позвать человека. */
export const dailyUserCounters = pgTable(
  'daily_user_counters',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    day: text('day').notNull(), // YYYY-MM-DD
    requests: integer('requests').notNull().default(0),
    humanCalls: integer('human_calls').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

/** AI: Агрегаты, которые ведёт worker аналитики (consumer Kafka). */
export const dailyStats = pgTable(
  'daily_stats',
  {
    day: text('day').notNull(), // YYYY-MM-DD
    tenantId: text('tenant_id').notNull(),
    categoryId: text('category_id').notNull(),
    created: integer('created').notNull().default(0),
    resolved: integer('resolved').notNull().default(0),
    escalated: integer('escalated').notNull().default(0),
    ratingSum: integer('rating_sum').notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.tenantId, t.categoryId] })],
);

export type TenantRow = typeof tenants.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type KbArticleRow = typeof kbArticles.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type TicketRow = typeof tickets.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
