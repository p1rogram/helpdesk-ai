import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TOPICS } from '@helpdesk/shared';
import type { AppContext } from '../context.js';
import { eventBase } from '../modules/events/index.js';
import { toCard, toChatMessage } from '../modules/tickets/repository.js';
import { QR_CLOSED, QR_AFTER_SOLUTION, T } from '../modules/dialog/templates.js';

const IdParam = z.object({ id: z.string().uuid() });
const ReplySchema = z.object({ text: z.string().trim().min(1).max(4000) });

/**
 * AI: Operator console: the built-in "specialist side". Escalated tickets land here; an operator
 * answers into the user's chat (push via the notification topic) and closes the ticket.
 * Restricted to ADMIN_USERS. An external helpdesk (Naumen) can replace or complement this.
 */
export async function operatorRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', app.requireAdmin);

  /**
   * AI: Work list, already grouped: 0 - the operator's own conversations, 1 - waiting for a first
   * reply (longest wait first), 2 - closed.
   */
  app.get('/api/operator/tickets', async (req) => {
    const rows = await ctx.tickets.listForOperator(req.user.tenant, 100);
    const catalog = await ctx.knowledge.catalog(req.user.tenant);
    return {
      tickets: rows.map((r) => ({
        ...toCard(r.ticket, catalog),
        user: { displayName: r.user.displayName, platform: r.user.platform },
        lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
        unanswered: r.unanswered,
        group: r.group,
      })),
    };
  });

  /** AI: Live queue updates (SSE): a new escalation or a user message appears without reloading. */
  app.get('/api/operator/stream', { config: { rateLimit: false } }, async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': (req.headers.origin as string) ?? '*',
    });
    reply.raw.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
    const detach = ctx.operatorHub.add({
      tenantId: req.user.tenant,
      send: (payload) => reply.raw.write(`data: ${payload}\n\n`),
    });
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      detach();
    });
    await new Promise(() => {}); // held open until the client disconnects
  });

  /**
   * AI: Hand the ticket back to the assistant: the operator decided it does not need a specialist.
   * The assistant resumes and is not allowed to escalate this ticket again.
   */
  app.post('/api/operator/tickets/:id/handback', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ticket = await ctx.tickets.getAny(id);
    if (!ticket || ticket.tenantId !== req.user.tenant) return reply.code(404).send({ error: 'not_found' });
    const user = (await ctx.tickets.getUser(ticket.userId))!;
    const text = T.handedBackToAi(req.user.name);
    await ctx.tickets.addMessage(ticket.id, 'assistant', text, {
      handback: true,
      quickReplies: ticket.articleId ? QR_AFTER_SOLUTION : [],
    });
    const updated = await ctx.tickets.update(ticket.id, {
      state: ticket.articleId ? 'solving' : 'intake',
      handledBy: 'ai',
      escalationBlocked: true,
      escalated: false,
      closedAt: null,
    });
    await ctx.events.publish(TOPICS.notifications, ticket.id, {
      eventId: eventBase(ticket.id, user.id).eventId,
      occurredAt: new Date().toISOString(),
      ticketId: ticket.id,
      platform: user.platform as 'telegram' | 'vk' | 'max' | 'web',
      platformUserId: user.platformUserId,
      text,
    });
    ctx.operatorHub.notify(ticket.tenantId, ticket.id);
    const catalog = await ctx.knowledge.catalog(ticket.tenantId);
    return { ticket: toCard(updated, catalog) };
  });

  app.get('/api/operator/tickets/:id', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ticket = await ctx.tickets.getAny(id);
    if (!ticket || ticket.tenantId !== req.user.tenant) return reply.code(404).send({ error: 'not_found' });
    const catalog = await ctx.knowledge.catalog(ticket.tenantId);
    const user = await ctx.tickets.getUser(ticket.userId);
    const msgs = await ctx.tickets.listMessages(ticket.id, 300);
    return {
      ticket: toCard(ticket, catalog),
      user: user ? { displayName: user.displayName, platform: user.platform } : null,
      messages: msgs.map(toChatMessage),
    };
  });

  /** AI: Operator reply -> stored in the chat, pushed to the messenger. */
  app.post('/api/operator/tickets/:id/reply', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = ReplySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
    const ticket = await ctx.tickets.getAny(id);
    if (!ticket || ticket.tenantId !== req.user.tenant) return reply.code(404).send({ error: 'not_found' });
    const user = (await ctx.tickets.getUser(ticket.userId))!;
    const saved = await ctx.tickets.addMessage(ticket.id, 'assistant', body.data.text, {
      operator: req.user.name,
      quickReplies: [],
    });
    await ctx.tickets.update(ticket.id, { state: 'escalated', handledBy: 'operator' });
    ctx.operatorHub.notify(ticket.tenantId, ticket.id);
    await ctx.events.publish(TOPICS.notifications, ticket.id, {
      eventId: eventBase(ticket.id, user.id).eventId,
      occurredAt: new Date().toISOString(),
      ticketId: ticket.id,
      platform: user.platform as 'telegram' | 'vk' | 'max' | 'web',
      platformUserId: user.platformUserId,
      text: `Специалист ответил по заявке №${ticket.externalId ?? ticket.id.slice(0, 8).toUpperCase()}:\n\n${body.data.text}`,
    });
    return { message: toChatMessage(saved) };
  });

  /** AI: Close as resolved by the operator. */
  app.post('/api/operator/tickets/:id/close', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ticket = await ctx.tickets.getAny(id);
    if (!ticket || ticket.tenantId !== req.user.tenant) return reply.code(404).send({ error: 'not_found' });
    const user = (await ctx.tickets.getUser(ticket.userId))!;
    const closingText = `Специалист ${req.user.name} закрыл заявку как решённую. Если проблема повторится — создайте новое обращение.`;
    await ctx.tickets.addMessage(ticket.id, 'assistant', closingText, { operator: req.user.name, quickReplies: QR_CLOSED });
    const updated = await ctx.tickets.update(ticket.id, { state: 'closed', resolved: true, closedAt: new Date() });
    ctx.operatorHub.notify(ticket.tenantId, ticket.id);
    const catalog = await ctx.knowledge.catalog(ticket.tenantId);
    await ctx.events.publish(TOPICS.ticketEvents, ticket.id, {
      ...eventBase(ticket.id, user.id),
      type: 'ticket.resolved',
      ticket: toCard(updated, catalog),
    });
    await ctx.events.publish(TOPICS.notifications, ticket.id, {
      eventId: eventBase(ticket.id, user.id).eventId,
      occurredAt: new Date().toISOString(),
      ticketId: ticket.id,
      platform: user.platform as 'telegram' | 'vk' | 'max' | 'web',
      platformUserId: user.platformUserId,
      text: `Заявка №${ticket.externalId ?? ticket.id.slice(0, 8).toUpperCase()} закрыта специалистом как решённая.`,
    });
    return { ticket: toCard(updated, catalog) };
  });
}
