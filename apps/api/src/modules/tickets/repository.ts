import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { ChatMessage, QuickReply, TicketCard, TicketState, Tone } from '@helpdesk/shared';
import type { Db } from '../../db/client.js';
import {
  answerCache,
  dailyUserCounters,
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
   * AI: Рабочий список оператора. Сгруппировано для консоли:
   *   0 - мои: взял себе или уже отвечал (сначала те, где новое сообщение)
   *   1 - ждут: у специалиста, никто не взял и не ответил (самые давние первыми - порядок SLA)
   *   2 - у коллег: взяты другим специалистом
   *   3 - закрыты специалистами
   *   4 - завершены без специалиста: помощником, через сервис-деск или отозваны пользователем
   * Заявки, живущие в сервис-деске (escalatedTo = helpdesk), в очередь не попадают, пока открыты.
   */
  async listForOperator(
    tenantId: string,
    me: string,
    limit = 150,
  ): Promise<
    Array<{
      ticket: TicketRow;
      user: UserRow;
      lastMessageAt: Date | null;
      unanswered: boolean;
      group: 0 | 1 | 2 | 3 | 4;
    }>
  > {
    const rows = await this.db
      .select({ ticket: tickets, user: users })
      .from(tickets)
      .innerJoin(users, eq(users.id, tickets.userId))
      .where(
        and(
          eq(tickets.tenantId, tenantId),
          or(
            and(eq(tickets.state, 'escalated'), eq(tickets.escalatedTo, 'operator')),
            eq(tickets.state, 'closed'),
          ),
        ),
      )
      .orderBy(desc(tickets.updatedAt))
      .limit(limit);

    const out: Array<{
      ticket: TicketRow;
      user: UserRow;
      lastMessageAt: Date | null;
      unanswered: boolean;
      group: 0 | 1 | 2 | 3 | 4;
    }> = [];
    for (const r of rows) {
      const closed = r.ticket.state === 'closed';
      let lastMessageAt: Date | null = r.ticket.updatedAt;
      let unanswered = false;
      let group: 0 | 1 | 2 | 3 | 4;
      if (closed) {
        group = r.ticket.closedBy === 'operator' ? 3 : 4;
      } else {
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
        lastMessageAt = last?.createdAt ?? null;
        unanswered = !operatorReplied || !last || last.role === 'user';
        const mine = r.ticket.assignedToId === me;
        group = mine ? 0 : r.ticket.assignedToId ? 2 : operatorReplied ? 2 : 1;
      }
      out.push({ ticket: r.ticket, user: r.user, lastMessageAt, unanswered, group });
    }

    const time = (d: Date | null | undefined) => (d ? d.getTime() : 0);
    return out.sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group;
      if (a.group === 1) return time(a.ticket.updatedAt) - time(b.ticket.updatedAt);
      if (a.group === 0 && a.unanswered !== b.unanswered) return a.unanswered ? -1 : 1;
      return (
        time(b.lastMessageAt ?? b.ticket.updatedAt) - time(a.lastMessageAt ?? a.ticket.updatedAt)
      );
    });
  }

  /** AI: Сводка для панели оператора: сегодня и за 7 дней. */
  async operatorStats(tenantId: string): Promise<{
    today: OperatorStats;
    week: OperatorStats;
    openQueue: number;
  }> {
    const since = (days: number) => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - days);
      return d;
    };
    const calc = async (from: Date): Promise<OperatorStats> => {
      const rows = await this.db
        .select({
          state: tickets.state,
          closedBy: tickets.closedBy,
          escalated: tickets.escalated,
          escalatedTo: tickets.escalatedTo,
          rating: tickets.rating,
          createdAt: tickets.createdAt,
          closedAt: tickets.closedAt,
        })
        .from(tickets)
        .where(
          and(
            eq(tickets.tenantId, tenantId),
            or(gte(tickets.createdAt, from), gte(tickets.closedAt, from)),
          ),
        );
      const st: OperatorStats = {
        created: 0,
        resolvedByAssistant: 0,
        closedByOperator: 0,
        sentToHelpdesk: 0,
        withdrawn: 0,
        escalated: 0,
        ratingSum: 0,
        ratingCount: 0,
      };
      for (const r of rows) {
        if (r.createdAt >= from) st.created++;
        if (r.escalated && r.closedAt && r.closedAt >= from) {
          if (r.escalatedTo === 'helpdesk') st.sentToHelpdesk++;
          else st.escalated++;
        }
        if (r.state === 'closed' && r.closedAt && r.closedAt >= from) {
          if (r.closedBy === 'assistant') st.resolvedByAssistant++;
          else if (r.closedBy === 'operator') st.closedByOperator++;
          else if (r.closedBy === 'user') st.withdrawn++;
        }
        if (r.rating && r.closedAt && r.closedAt >= from) {
          st.ratingSum += r.rating;
          st.ratingCount++;
        }
      }
      return st;
    };
    const [today, week, open] = await Promise.all([
      calc(since(0)),
      calc(since(6)),
      this.db
        .select({ id: tickets.id })
        .from(tickets)
        .where(
          and(
            eq(tickets.tenantId, tenantId),
            eq(tickets.state, 'escalated'),
            eq(tickets.escalatedTo, 'operator'),
          ),
        ),
    ]);
    return { today, week, openQueue: open.length };
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

  // ---------- кэш справочных ответов ----------

  async cacheGet(
    key: string,
  ): Promise<{ text: string; sources: Array<{ url: string; title: string }> } | null> {
    const [row] = await this.db.select().from(answerCache).where(eq(answerCache.key, key)).limit(1);
    if (!row) return null;
    if (Date.now() - row.createdAt.getTime() > 24 * 3600 * 1000) {
      await this.db.delete(answerCache).where(eq(answerCache.key, key));
      return null;
    }
    return { text: row.text, sources: row.sources };
  }

  async cacheSet(
    key: string,
    text: string,
    sources: Array<{ url: string; title: string }>,
  ): Promise<void> {
    await this.db
      .insert(answerCache)
      .values({ key, text, sources })
      .onConflictDoUpdate({
        target: answerCache.key,
        set: { text, sources, createdAt: new Date() },
      });
  }

  // ---------- дневные лимиты ----------

  /** AI: Счётчики за сегодня (по UTC-дате сервера): заявки и просьбы позвать человека. */
  async countersToday(userId: string): Promise<{ requests: number; humanCalls: number }> {
    const [row] = await this.db
      .select()
      .from(dailyUserCounters)
      .where(and(eq(dailyUserCounters.userId, userId), eq(dailyUserCounters.day, today())))
      .limit(1);
    return { requests: row?.requests ?? 0, humanCalls: row?.humanCalls ?? 0 };
  }

  async bumpCounter(userId: string, kind: 'requests' | 'humanCalls'): Promise<void> {
    const col = kind === 'requests' ? dailyUserCounters.requests : dailyUserCounters.humanCalls;
    await this.db
      .insert(dailyUserCounters)
      .values({ userId, day: today(), [kind]: 1 })
      .onConflictDoUpdate({
        target: [dailyUserCounters.userId, dailyUserCounters.day],
        set: { [kind]: sql`${col} + 1` },
      });
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
    closedByName: t.closedByName ?? null,
    assignedTo: t.assignedTo ?? null,
    specialistReadAt: t.operatorReadAt?.toISOString() ?? null,
    pendingProblems: t.pendingProblems ?? [],
    pendingFields: t.pendingFields ?? [],
    escalatedTo: t.escalatedTo as TicketCard['escalatedTo'],
    kind: (t.kind === 'question' ? 'question' : 'problem') as TicketCard['kind'],
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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface OperatorStats {
  created: number;
  resolvedByAssistant: number;
  closedByOperator: number;
  sentToHelpdesk: number;
  withdrawn: number;
  escalated: number;
  ratingSum: number;
  ratingCount: number;
}
