import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';

/**
 * AI: Счётчики со скользящим окном в таблице rate_limits - общие для всех реплик API. На них
 * стоят и HTTP rate-limit, и бюджет модели для гостей, и суточный расход токенов. Окно и счётчик
 * меняются одним UPSERT, поэтому конкурентные реплики не теряют инкременты: истёкшее окно
 * начинается заново, живое - увеличивается.
 */
export class WindowCounters {
  constructor(private readonly db: Db) {}

  /** AI: Увеличить на `by` и вернуть текущее значение окна и остаток его жизни (мс). */
  async bump(key: string, windowMs: number, by = 1): Promise<{ count: number; ttl: number }> {
    const res = (await this.db.execute(
      sql`INSERT INTO rate_limits (key, count, expires_at)
          VALUES (${key}, ${by}, now() + (${windowMs}::text || ' milliseconds')::interval)
          ON CONFLICT (key) DO UPDATE SET
            count = CASE WHEN rate_limits.expires_at <= now() THEN ${by} ELSE rate_limits.count + ${by} END,
            expires_at = CASE WHEN rate_limits.expires_at <= now()
              THEN now() + (${windowMs}::text || ' milliseconds')::interval
              ELSE rate_limits.expires_at END
          RETURNING count, (EXTRACT(EPOCH FROM (expires_at - now())) * 1000)::bigint AS ttl`,
    )) as unknown as { rows: Array<{ count: number | string; ttl: number | string }> };
    const row = res.rows[0];
    return {
      count: Number(row?.count ?? by),
      ttl: Math.max(0, Number(row?.ttl ?? windowMs)),
    };
  }

  /** AI: Текущее значение без инкремента; истёкшее окно = 0. */
  async peek(key: string): Promise<number> {
    const res = (await this.db.execute(
      sql`SELECT count FROM rate_limits WHERE key = ${key} AND expires_at > now()`,
    )) as unknown as { rows: Array<{ count: number | string }> };
    return Number(res.rows[0]?.count ?? 0);
  }

  /** AI: Несколько ключей за один запрос. */
  async peekMany(keys: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!keys.length) return out;
    const res = (await this.db.execute(
      sql`SELECT key, count FROM rate_limits WHERE key IN (${sql.join(
        keys.map((k) => sql`${k}`),
        sql`, `,
      )}) AND expires_at > now()`,
    )) as unknown as { rows: Array<{ key: string; count: number | string }> };
    for (const r of res.rows) out.set(r.key, Number(r.count));
    return out;
  }

  /** AI: Чистка истёкших окон; вызывается раз в несколько минут. */
  async sweep(): Promise<void> {
    await this.db.execute(
      sql`DELETE FROM rate_limits WHERE expires_at < now() - interval '1 hour'`,
    );
  }
}
