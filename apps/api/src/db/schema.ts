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
 * AI: Drizzle schema. Every query goes through the query builder -> parameterised SQL,
 * so SQL injection is impossible by construction (no string concatenation anywhere).
 *
 * Multi-tenancy: a tenant is a "sphere" (TPU, corporate IT, ISP...). Catalog rows and
 * tickets carry tenant_id, so one installation serves many spheres side by side.
 */

// ---------- Catalog (editable at runtime via admin API, seeded from data/catalog/*.json) ----------

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(), // "tpu", "it-support"
  sphere: text('sphere').notNull(),
  organisation: text('organisation').notNull(),
  language: text('language').notNull().default('ru'),
  /** AI: Bumped on every catalog change - used for cache invalidation and prompt-cache keys. */
  version: integer('version').notNull().default(1),
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

// ---------- RAG corpus (crawled documentation, chunked and embedded) ----------

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
    /** AI: sha1 of the content - unchanged chunks are not re-embedded on re-ingest. */
    contentHash: text('content_hash').notNull(),
    embedding: jsonb('embedding').$type<number[]>(),
    embeddingModel: text('embedding_model'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rag_chunks_tenant').on(t.tenantId)],
);

// ---------- Users / tickets / messages ----------

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
    /** AI: Clarifying field the last question was about (answer maps to this key). */
    pendingField: text('pending_field'),
    /** AI: Current article shown to the user. */
    articleId: text('article_id'),
    /** AI: Articles already tried and rejected ("not helped"). */
    triedArticles: jsonb('tried_articles').$type<string[]>().notNull().default([]),
    resolved: boolean('resolved').notNull().default(false),
    escalated: boolean('escalated').notNull().default(false),
    escalationReason: text('escalation_reason'),
    /** AI: 'ai' | 'operator' - while 'operator' the assistant does not answer in this ticket. */
    handledBy: text('handled_by').notNull().default('ai'),
    /** AI: Operator returned the ticket to the assistant and forbade escalating it again. */
    escalationBlocked: boolean('escalation_blocked').notNull().default(false),
    /** AI: Request number / link in the external helpdesk after escalation. */
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    /** AI: Why the assistant offered escalation (kept while the user decides). */
    pendingEscalation: text('pending_escalation'),
    rating: integer('rating'),
    ratingComment: text('rating_comment'),
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

/** AI: Aggregates maintained by the analytics worker (Kafka consumer). */
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
