import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { ChatMessage, QuickReply, TicketCard, TicketState, Tone } from '@helpdesk/shared';
import type { Db } from '../../db/client.js';
import {
  messages,
  tickets,
  users,
  type MessageRow,
  type TicketRow,
  type UserRow,
} from '../../db/schema.js';
import type { LoadedCatalog } from '../knowledge/index.js';

export class TicketRepository {
  constructor(private readonly db: Db) {}

  // ---------- пользователи ----------

  async upsertUser(
    platform: string,
    platformUserId: string,
    displayName: string,
  ): Promise<UserRow> {
    const [row] = await this.db
      .insert(users)
      .values({ platform, platformUserId, displayName })
      .onConflictDoUpdate({ target: [users.platform, users.platformUserId], set: { displayName } })
      .returning();
    return row!;
  }

  async getUser(id: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row;
  }

  // ---------- тикеты ----------

  async create(tenantId: string, userId: string): Promise<TicketRow> {
    const [row] = await this.db.insert(tickets).values({ tenantId, userId }).returning();
    return row!;
  }

  async get(id: string, userId: string): Promise<TicketRow | undefined> {
    const [row] = await this.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.userId, userId)))
      .limit(1);
    return row;
  }

  /** AI: Последний ещё открытый тикет (не закрыт / не передан), если есть. */
  async latestOpen(userId: string): Promise<TicketRow | undefined> {
    const [row] = await this.db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.userId, userId),
          inArray(tickets.state, [
            'intake',
            'clarifying',
            'choosing_category',
            'solving',
            'offer_escalation',
          ]),
        ),
      )
      .orderBy(desc(tickets.createdAt))
      .limit(1);
    return row;
  }

  /**
   * AI: Удалить тикеты, в которых так и не появилось сообщения пользователя (брошенные
   * приветствия).
   */
  async pruneEmpty(userId: string, keepId?: string): Promise<void> {
    const rows = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.userId, userId), eq(tickets.state, 'intake')));
    for (const r of rows) {
      if (r.id === keepId) continue;
      const [m] = await this.db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.ticketId, r.id), eq(messages.role, 'user')))
        .limit(1);
      if (m) continue;
      await this.db.delete(messages).where(eq(messages.ticketId, r.id));
      await this.db.delete(tickets).where(eq(tickets.id, r.id));
    }
  }

  /** AI: Любой тикет по id (доступ оператора - без привязки к запрашивающему пользователю). */
  async getAny(id: string): Promise<TicketRow | undefined> {
    const [row] = await this.db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
    return row;
  }

  /**
   * AI: Рабочий список оператора: всё, что дошло до специалиста. Сгруппировано для консоли:
   *   0 - в работе: оператор уже ответил (его диалоги идут первыми)
   *   1 - ждут: передано, но ответа оператора ещё нет (самые давние первыми - порядок SLA)
   *   2 - закрыто: завершённые, новые первыми
   */
  async listForOperator(
    tenantId: string,
    limit = 100,
  ): Promise<
    Array<{
      ticket: TicketRow;
      user: UserRow;
      lastMessageAt: Date | null;
      unanswered: boolean;
      group: 0 | 1 | 2;
    }>
  > {
    const rows = await this.db
      .select({ ticket: tickets, user: users })
      .from(tickets)
      .innerJoin(users, eq(users.id, tickets.userId))
      .where(
        and(
          eq(tickets.tenantId, tenantId),
          eq(tickets.escalated, true),
          inArray(tickets.state, ['escalated', 'closed']),
        ),
      )
      .orderBy(desc(tickets.updatedAt))
      .limit(limit);

    const out: Array<{
      ticket: TicketRow;
      user: UserRow;
      lastMessageAt: Date | null;
      unanswered: boolean;
      group: 0 | 1 | 2;
    }> = [];
    for (const r of rows) {
      const recent = await this.db
        .select({ role: messages.role, createdAt: messages.createdAt, meta: messages.meta })
        .from(messages)
        .where(eq(messages.ticketId, r.ticket.id))
        .orderBy(desc(messages.createdAt))
        .limit(50);
      const operatorReplied = recent.some((m) =>
        Boolean((m.meta as { operator?: string }).operator),
      );
      const last = recent[0];
      const unanswered = !operatorReplied || !last || last.role === 'user';
      const group: 0 | 1 | 2 = r.ticket.state === 'closed' ? 2 : operatorReplied ? 0 : 1;
      out.push({
        ticket: r.ticket,
        user: r.user,
        lastMessageAt: last?.createdAt ?? null,
        unanswered,
        group,
      });
    }

    const time = (d: Date | null | undefined) => (d ? d.getTime() : 0);
    return out.sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group;
      // AI: В работе и закрытые: свежая активность первой. Ждущие: самое долгое ожидание первым.
      if (a.group === 1) return time(a.ticket.updatedAt) - time(b.ticket.updatedAt);
      return (
        time(b.lastMessageAt ?? b.ticket.updatedAt) - time(a.lastMessageAt ?? a.ticket.updatedAt)
      );
    });
  }

  async listForUser(userId: string, limit = 20): Promise<TicketRow[]> {
    return this.db
      .select()
      .from(tickets)
      .where(eq(tickets.userId, userId))
      .orderBy(desc(tickets.createdAt))
      .limit(limit);
  }

  /**
   * AI: Взять аренду обработки на один проход движка. Атомарно в базе, поэтому две реплики (или
   * двойной тап) не смогут одновременно обработать один тикет; истёкшая аренда перехватывается.
   */
  async tryLock(id: string, ttlMs: number): Promise<boolean> {
    const now = new Date();
    const rows = await this.db
      .update(tickets)
      .set({ busyUntil: new Date(now.getTime() + ttlMs) })
      .where(and(eq(tickets.id, id), or(isNull(tickets.busyUntil), lt(tickets.busyUntil, now))))
      .returning({ id: tickets.id });
    return rows.length > 0;
  }

  async unlock(id: string): Promise<void> {
    await this.db.update(tickets).set({ busyUntil: null }).where(eq(tickets.id, id));
  }

  async update(id: string, patch: Partial<TicketRow>): Promise<TicketRow> {
    const [row] = await this.db
      .update(tickets)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(tickets.id, id))
      .returning();
    return row!;
  }

  // ---------- сообщения ----------

  async addMessage(
    ticketId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    meta: Record<string, unknown> = {},
  ): Promise<MessageRow> {
    const [row] = await this.db
      .insert(messages)
      .values({ ticketId, role, content, meta })
      .returning();
    return row!;
  }

  async listMessages(ticketId: string, limit = 100): Promise<MessageRow[]> {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.ticketId, ticketId))
      .orderBy(asc(messages.createdAt))
      .limit(limit);
  }
}

// ---------- преобразователи ----------

export function toCard(t: TicketRow, catalog: LoadedCatalog): TicketCard {
  const cat = t.categoryId ? catalog.categoryById.get(t.categoryId) : undefined;
  const art = t.articleId ? catalog.articleById.get(t.articleId) : undefined;
  return {
    id: t.id,
    tenantId: t.tenantId,
    state: t.state as TicketState,
    categoryId: t.categoryId,
    categoryName: cat?.name ?? null,
    priority: t.priority as TicketCard['priority'],
    confidence: t.confidence,
    summary: t.summary,
    fields: t.fields,
    fieldLabels: Object.fromEntries((cat?.clarify ?? []).map((f) => [f.id, f.label ?? f.id])),
    tone: t.tone as Tone,
    articleId: t.articleId,
    articleTitle: art?.title ?? null,
    resolved: t.resolved,
    escalated: t.escalated,
    rating: t.rating,
    closedBy: t.closedBy as TicketCard['closedBy'],
    handledBy: t.handledBy as 'ai' | 'operator',
    escalationBlocked: t.escalationBlocked,
    externalId: t.externalId,
    externalUrl: t.externalUrl,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function toChatMessage(m: MessageRow): ChatMessage {
  const meta = m.meta as { quickReplies?: QuickReply[]; operator?: string };
  return {
    id: m.id,
    role: m.role as ChatMessage['role'],
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    ...(meta.quickReplies?.length ? { quickReplies: meta.quickReplies } : {}),
    ...(meta.operator ? { author: meta.operator } : {}),
  };
}
