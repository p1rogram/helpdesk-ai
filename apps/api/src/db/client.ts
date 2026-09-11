import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  kind: 'postgres' | 'pglite';
  close(): Promise<void>;
}

/**
 * AI: Postgres in production, embedded PGlite (same SQL dialect) when DATABASE_URL is empty.
 * Same schema, same queries - zero-install dev/demo mode without Docker.
 */
export async function connectDb(opts: { url?: string; pgliteDir: string }): Promise<DbHandle> {
  if (opts.url) {
    const pool = new pg.Pool({ connectionString: opts.url, max: 10 });
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    return { db, kind: 'postgres', close: () => pool.end() };
  }
  // AI: pgvector is bundled with PGlite, so dev and prod run the same vector SQL.
  const client = new PGlite(opts.pgliteDir, { extensions: { vector } });
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return { db, kind: 'pglite', close: () => client.close() };
}

/**
 * AI: Idempotent bootstrap DDL. For a hackathon this beats a migration toolchain: one file,
 * runs on every boot, safe to re-run. drizzle-kit migrations can replace it later.
 */
export async function ensureSchema(db: Db): Promise<void> {
  // AI: One statement per call: PGlite (and pg prepared statements) reject multi-command strings.
  for (const stmt of DDL) {
    await db.execute(sql.raw(stmt));
  }
  // AI: Additive migrations for databases created before these columns existed.
  for (const col of [
    'external_id TEXT',
    'external_url TEXT',
    'pending_escalation TEXT',
    "handled_by TEXT NOT NULL DEFAULT 'ai'",
    'escalation_blocked BOOLEAN NOT NULL DEFAULT false',
    'closed_by TEXT',
    'busy_until TIMESTAMPTZ',
  ]) {
    await db.execute(sql.raw(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ${col}`));
  }
  await db.execute(
    sql.raw(
      "ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'internal'",
    ),
  );
}

const DDL: string[] = [
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
  // AI: RAG corpus. Chunks of crawled documentation with their dense vector; the vector is a JSON
  // float array so the same schema works in PGlite (dev) and Postgres (prod). Upgrade path for
  // hundreds of thousands of chunks: pgvector column + HNSW index behind the same RagService API.
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
];
