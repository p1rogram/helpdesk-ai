import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { LlmUsageEvent, TicketEvent } from '@helpdesk/shared';
import type { Db } from '@helpdesk/api/dist/db/client.js';
import { dailyStats } from '@helpdesk/api/dist/db/schema.js';

/**
 * Maintains daily aggregates from the event stream. Idempotency note: counters are
 * incremented per event; for exactly-once semantics store processed eventIds (out of scope here).
 */
export class AnalyticsConsumer {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  async onTicketEvent(e: TicketEvent): Promise<void> {
    const day = e.occurredAt.slice(0, 10);
    let inc: { created?: number; resolved?: number; escalated?: number; rating?: number } = {};
    let tenantId = 'unknown';
    let categoryId = 'unknown';
    switch (e.type) {
      case 'ticket.created':
        inc = { created: 1 };
        ({ tenantId, categoryId } = keyOf(e.ticket));
        break;
      case 'ticket.resolved':
        inc = { resolved: 1 };
        ({ tenantId, categoryId } = keyOf(e.ticket));
        break;
      case 'ticket.escalated':
        inc = { escalated: 1 };
        ({ tenantId, categoryId } = keyOf(e.ticket));
        break;
      case 'ticket.rated':
        inc = { rating: e.rating };
        break;
      default:
        return;
    }
    await this.db
      .insert(dailyStats)
      .values({
        day,
        tenantId,
        categoryId,
        created: inc.created ?? 0,
        resolved: inc.resolved ?? 0,
        escalated: inc.escalated ?? 0,
        ratingSum: inc.rating ?? 0,
        ratingCount: inc.rating ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [dailyStats.day, dailyStats.tenantId, dailyStats.categoryId],
        set: {
          created: sql`${dailyStats.created} + ${inc.created ?? 0}`,
          resolved: sql`${dailyStats.resolved} + ${inc.resolved ?? 0}`,
          escalated: sql`${dailyStats.escalated} + ${inc.escalated ?? 0}`,
          ratingSum: sql`${dailyStats.ratingSum} + ${inc.rating ?? 0}`,
          ratingCount: sql`${dailyStats.ratingCount} + ${inc.rating ? 1 : 0}`,
        },
      });
    this.log.debug({ type: e.type, day, tenantId, categoryId }, 'analytics updated');
  }

  async onLlmUsage(e: LlmUsageEvent): Promise<void> {
    const day = e.occurredAt.slice(0, 10);
    await this.db
      .insert(dailyStats)
      .values({ day, tenantId: 'all', categoryId: '_llm', inputTokens: e.inputTokens, outputTokens: e.outputTokens })
      .onConflictDoUpdate({
        target: [dailyStats.day, dailyStats.tenantId, dailyStats.categoryId],
        set: {
          inputTokens: sql`${dailyStats.inputTokens} + ${e.inputTokens}`,
          outputTokens: sql`${dailyStats.outputTokens} + ${e.outputTokens}`,
        },
      });
  }
}

function keyOf(t: { tenantId: string; categoryId: string | null }): { tenantId: string; categoryId: string } {
  return { tenantId: t.tenantId, categoryId: t.categoryId ?? 'unknown' };
}
