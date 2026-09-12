import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectDb, ensureSchema, type DbHandle } from '../db/client.js';
import { MIGRATIONS } from '../db/migrations.js';
import { DbRateLimitStore, parseWindow } from '../plugins/rate-limit-store.js';

let handle: DbHandle;

beforeAll(async () => {
  handle = await connectDb({ pgliteDir: mkdtempSync(path.join(tmpdir(), 'helpdesk-infra-')) });
});
afterAll(async () => handle.close());

describe('versioned migrations', () => {
  it('applies every step once and records it', async () => {
    const first = await ensureSchema(handle.db);
    expect(first.applied).toEqual(MIGRATIONS.map((m) => m.id));

    const second = await ensureSchema(handle.db);
    expect(second.applied).toEqual([]);

    const rows = (await handle.db.execute(
      sql.raw('SELECT id FROM schema_migrations ORDER BY id'),
    )) as unknown as { rows: Array<{ id: string }> };
    expect(rows.rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('has unique, ordered ids', () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('shared rate-limit store', () => {
  const incr = (store: DbRateLimitStore, key: string) =>
    new Promise<{ current: number; ttl: number }>((resolve, reject) =>
      store.incr(key, (err, res) => (err ? reject(err) : resolve(res!))),
    );

  it('counts within the window and restarts after it expires', async () => {
    const store = new DbRateLimitStore(handle.db, 400);
    expect((await incr(store, 'ip:1')).current).toBe(1);
    expect((await incr(store, 'ip:1')).current).toBe(2);
    const third = await incr(store, 'ip:1');
    expect(third.current).toBe(3);
    expect(third.ttl).toBeGreaterThan(0);
    expect(third.ttl).toBeLessThanOrEqual(400);
    // AI: Другой ключ - другой счётчик.
    expect((await incr(store, 'ip:2')).current).toBe(1);

    await new Promise((r) => setTimeout(r, 450));
    expect((await incr(store, 'ip:1')).current).toBe(1);
  });

  it('keeps per-route children separate from the global counter', async () => {
    const store = new DbRateLimitStore(handle.db, 60_000);
    const child = store.child({
      method: 'POST',
      path: '/api/auth/dev',
      prefix: '',
      config: { rateLimit: { timeWindow: '1 minute' } },
    });
    await incr(store, 'u:1');
    await incr(store, 'u:1');
    expect((await incr(child, 'u:1')).current).toBe(1);
  });

  it('plugs into @fastify/rate-limit and returns 429 past the limit', async () => {
    const store = new DbRateLimitStore(handle.db, 60_000);
    const app = Fastify();
    await app.register(rateLimit, {
      max: 2,
      timeWindow: '1 minute',
      keyGenerator: () => 'same-client',
      store: class {
        constructor() {
          return store;
        }
      } as unknown as NonNullable<Parameters<typeof rateLimit>[1]>['store'],
    });
    app.get('/x', async () => ({ ok: true }));
    app.get('/auth', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({
      ok: true,
    }));
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject({ url: '/x' })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    // AI: Маршрут со своим лимитом считается отдельно от общего.
    expect((await app.inject({ url: '/auth' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/auth' })).statusCode).toBe(429);
    await app.close();
  });

  it('parses time windows', () => {
    expect(parseWindow('1 minute', 0)).toBe(60_000);
    expect(parseWindow('10 minutes', 0)).toBe(600_000);
    expect(parseWindow(1500, 0)).toBe(1500);
    expect(parseWindow('garbage', 7)).toBe(7);
  });
});
