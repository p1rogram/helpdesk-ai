import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

type IncrCallback = (error: Error | null, result?: { current: number; ttl: number }) => void;

/**
 * AI: Хранилище счётчиков @fastify/rate-limit в таблице rate_limits. Встроенное хранилище живёт в
 * памяти процесса: при `--scale api=3` у каждой реплики свой счётчик и лимит фактически умножается
 * на число реплик. Одна таблица в Postgres даёт общий лимит на всех; для пары сотен запросов в
 * минуту это один UPSERT на запрос - дешевле, чем поднимать Redis ради одного счётчика.
 *
 * Логика окна - в одном выражении, поэтому конкурентные реплики не теряют инкременты:
 * истёкшее окно начинается заново с count = 1, живое - увеличивается на 1.
 */
export class DbRateLimitStore {
  private readonly prefix: string;

  constructor(
    private readonly db: Db,
    private readonly timeWindowMs: number,
    prefix = '',
  ) {
    this.prefix = prefix;
  }

  incr(key: string, cb: IncrCallback): void {
    const fullKey = `${this.prefix}${key}`;
    const windowMs = this.timeWindowMs;
    this.db
      .execute(
        sql`INSERT INTO rate_limits (key, count, expires_at)
            VALUES (${fullKey}, 1, now() + (${windowMs}::text || ' milliseconds')::interval)
            ON CONFLICT (key) DO UPDATE SET
              count = CASE WHEN rate_limits.expires_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
              expires_at = CASE WHEN rate_limits.expires_at <= now()
                THEN now() + (${windowMs}::text || ' milliseconds')::interval
                ELSE rate_limits.expires_at END
            RETURNING count, (EXTRACT(EPOCH FROM (expires_at - now())) * 1000)::bigint AS ttl`,
      )
      .then((res) => {
        const row = (
          res as unknown as { rows: Array<{ count: number | string; ttl: number | string }> }
        ).rows[0];
        cb(null, {
          current: Number(row?.count ?? 1),
          ttl: Math.max(0, Number(row?.ttl ?? windowMs)),
        });
      })
      .catch((err: unknown) => cb(err instanceof Error ? err : new Error(String(err))));
  }

  /** AI: Отдельный счётчик на маршрут с собственным лимитом (например, /api/auth/*). */
  child(routeOptions: { path?: string; prefix?: string; config?: unknown; method?: string }) {
    const cfg = (routeOptions.config as { rateLimit?: { timeWindow?: number | string } })
      ?.rateLimit;
    const windowMs = parseWindow(cfg?.timeWindow, this.timeWindowMs);
    const key = `${routeOptions.method ?? ''} ${routeOptions.prefix ?? ''}${routeOptions.path ?? ''}:`;
    return new DbRateLimitStore(this.db, windowMs, key);
  }

  /** AI: Чистка истёкших окон; вызывается раз в несколько минут из плагина. */
  async sweep(): Promise<void> {
    await this.db.execute(
      sql`DELETE FROM rate_limits WHERE expires_at < now() - interval '1 hour'`,
    );
  }
}

/** AI: @fastify/rate-limit принимает окно и числом (мс), и строкой вида '1 minute' / '10 minutes'. */
export function parseWindow(v: number | string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v === 'number') return v;
  const m = /^(\d+)\s*(ms|millisecond|second|minute|hour|day)s?$/i.exec(v.trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const mult: Record<string, number> = {
    ms: 1,
    millisecond: 1,
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
  };
  return n * (mult[unit] ?? 1);
}
