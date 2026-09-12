import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import * as schema from './schema.js';
import { MIGRATIONS } from './migrations.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  kind: 'postgres' | 'pglite';
  close(): Promise<void>;
}

/**
 * AI: В production - Postgres, при пустом DATABASE_URL - встроенный PGlite (тот же диалект SQL).
 * Одна схема, одни запросы - dev/demo без Docker и без установки.
 */
export async function connectDb(opts: { url?: string; pgliteDir: string }): Promise<DbHandle> {
  if (opts.url) {
    const pool = new pg.Pool({ connectionString: opts.url, max: 10 });
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    return { db, kind: 'postgres', close: () => pool.end() };
  }
  // AI: pgvector входит в PGlite, поэтому dev и prod выполняют один и тот же векторный SQL.
  const client = new PGlite(opts.pgliteDir, { extensions: { vector } });
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return { db, kind: 'pglite', close: () => client.close() };
}

/**
 * AI: Версионированные миграции при старте. Таблица schema_migrations хранит id уже применённых
 * шагов; новые шаги из MIGRATIONS применяются по порядку, каждый - в своей транзакции. Один и тот
 * же механизм работает в Postgres (prod) и PGlite (dev/тесты). Отдельная команда:
 * `npm run db:migrate -w @helpdesk/api`.
 */
export async function ensureSchema(
  db: Db,
  log?: { info(msg: string): void },
): Promise<{ applied: string[] }> {
  await db.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    ),
  );
  const res = (await db.execute(sql.raw('SELECT id FROM schema_migrations'))) as unknown as {
    rows: Array<{ id: string }>;
  };
  const done = new Set(res.rows.map((r) => r.id));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    // AI: По одному выражению на вызов: PGlite (и prepared statements в pg) не принимают строки с
    // несколькими командами.
    await db.transaction(async (tx) => {
      for (const stmt of m.statements) await tx.execute(sql.raw(stmt));
      await tx.execute(sql`INSERT INTO schema_migrations (id) VALUES (${m.id})`);
    });
    applied.push(m.id);
    log?.info(`migration applied: ${m.id}`);
  }
  return { applied };
}
