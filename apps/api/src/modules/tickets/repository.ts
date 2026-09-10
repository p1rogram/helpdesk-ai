import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { ChatMessage, QuickReply, TicketCard, TicketState, Tone } from '@helpdesk/shared';
import type { Db } from '../../db/client.js';
import { messages, tickets, users, type MessageRow, type TicketRow, type UserRow } from '../../db/schema.js';
import type { LoadedCatalog } from '../knowledge/index.js';

export class TicketRepository {
  constructor(private readonly db: Db) {}

  // ---------- users ----------

  async upsertUser(platform: string, platformUserId: string, displayName: string): Promise<UserRow> {
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

  // ---------- tickets ----------

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

  /** Latest ticket that is still open (not closed / escalated), if any. */
  async latestOpen(userId: string): Promise<TicketRow | undefined> {
    const [row] = await this.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.userId, userId), inArray(tickets.state, ['intake', 'clarifying', 'choosing_category', 'solving'])))
      .orderBy(desc(tickets.createdAt))
      .limit(1);
    return row;
  }

  /** Delete tickets that never received a user message (abandoned greetings). */
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

  /** Any ticket by id (operator access - not scoped to the requesting user). */
  async getAny(id: string): Promise<TicketRow | undefined> {
    const [row] = await this.db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
    return row;
  }

  /** Operator queue: escalated tickets of a tenant with user info and "waiting for reply" flag. */
  async listEscalated(
    tenantId: string,
    limit = 100,
  ): Promise<Array<{ ticket: TicketRow; user: UserRow; lastMessageAt: Date | null; unanswered: boolean }>> {
    const rows = await this.db
      .select({ ticket: tickets, user: users })
      .from(tickets)
      .innerJoin(users, eq(users.id, tickets.userId))
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.state, 'escalated')))
      .orderBy(desc(tickets.updatedAt))
      .limit(limit);
    const out = [];
    for (const r of rows) {
      const [last] = await this.db
        .select({ role: messages.role, createdAt: messages.createdAt, meta: messages.meta })
        .from(messages)
        .where(eq(messages.ticketId, r.ticket.id))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      const unanswered = !last || last.role === 'user' || !(last.meta as { operator?: string }).operator;
      out.push({ ticket: r.ticket, user: r.user, lastMessageAt: last?.createdAt ?? null, unanswered });
    }
    return out;
  }

  async listForUser(userId: string, limit = 20): Promise<TicketRow[]> {
    return this.db
      .select()
      .from(tickets)
      .where(eq(tickets.userId, userId))
      .orderBy(desc(tickets.createdAt))
      .limit(limit);
  }

  async update(id: string, patch: Partial<TicketRow>): Promise<TicketRow> {
    const [row] = await this.db
      .update(tickets)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(tickets.id, id))
      .returning();
    return row!;
  }

  // ---------- messages ----------

  async addMessage(
    ticketId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    meta: Record<string, unknown> = {},
  ): Promise<MessageRow> {
    const [row] = await this.db.insert(messages).values({ ticketId, role, content, meta }).returning();
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

// ---------- mappers ----------

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
    tone: t.tone as Tone,
    articleId: t.articleId,
    articleTitle: art?.title ?? null,
    resolved: t.resolved,
    escalated: t.escalated,
    rating: t.rating,
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
