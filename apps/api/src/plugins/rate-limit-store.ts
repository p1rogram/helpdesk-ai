import type { Db } from '../db/client.js';
import { WindowCounters } from '../modules/usage/counters.js';

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
  private readonly counters: WindowCounters;

  constructor(
    db: Db | WindowCounters,
    private readonly timeWindowMs: number,
    private readonly prefix = '',
  ) {
    this.counters = db instanceof WindowCounters ? db : new WindowCounters(db);
  }

  incr(key: string, cb: IncrCallback): void {
    this.counters
      .bump(`${this.prefix}${key}`, this.timeWindowMs)
      .then((r) => cb(null, { current: r.count, ttl: r.ttl }))
      .catch((err: unknown) => cb(err instanceof Error ? err : new Error(String(err))));
  }

  /** AI: Отдельный счётчик на маршрут с собственным лимитом (например, /api/auth/*). */
  child(routeOptions: { path?: string; prefix?: string; config?: unknown; method?: string }) {
    const cfg = (routeOptions.config as { rateLimit?: { timeWindow?: number | string } })
      ?.rateLimit;
    const windowMs = parseWindow(cfg?.timeWindow, this.timeWindowMs);
    const key = `${routeOptions.method ?? ''} ${routeOptions.prefix ?? ''}${routeOptions.path ?? ''}:`;
    return new DbRateLimitStore(this.counters, windowMs, key);
  }

  sweep(): Promise<void> {
    return this.counters.sweep();
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
