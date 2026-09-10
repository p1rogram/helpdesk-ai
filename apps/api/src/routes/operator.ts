import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TOPICS } from '@helpdesk/shared';
import type { AppContext } from '../context.js';
import { eventBase } from '../modules/events/index.js';
import { toCard, toChatMessage } from '../modules/tickets/repository.js';
import { QR_CLOSED } from '../modules/dialog/templates.js';

const IdParam = z.object({ id: z.string().uuid() });
const ReplySchema = z.object({ text: z.string().trim().min(1).max(4000) });

/**
 * Operator console: the built-in "specialist side". Escalated tickets land here; an operator
 * answers into the user's chat (push via the notification topic) and closes the ticket.
 * Restricted to ADMIN_USERS. An external helpdesk (Naumen) can replace or complement this.
 */
export async function operatorRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', app.requireAdmin);

  /** Queue: escalated, not yet resolved - newest first, across all users of the tenant. */
  app.get('/api/operator/tickets', async (req) => {
    const rows = await ctx.tickets.listEscalated(req.user.tenant, 100);
    const catalog = await ctx.knowledge.catalog(req.user.tenant);
    return {
      tickets: rows.map((r) => ({
        ...toCard(r.ticket, catalog),
        user: { displayName: r.user.displayName, platform: r.user.platform },
        lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
        unanswered: r.unanswered,
      })),
    };
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

  /** Operator reply -> stored in the chat, pushed to the messenger. */
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
    await ctx.tickets.update(ticket.id, { state: 'escalated' });
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

  /** Close as resolved by the operator. */
  app.post('/api/operator/tickets/:id/close', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ticket = await ctx.tickets.getAny(id);
    if (!ticket || ticket.tenantId !== req.user.tenant) return reply.code(404).send({ error: 'not_found' });
    const user = (await ctx.tickets.getUser(ticket.userId))!;
    const closingText = `Специалист ${req.user.name} закрыл заявку как решённую. Если проблема повторится — создайте новое обращение.`;
    await ctx.tickets.addMessage(ticket.id, 'assistant', closingText, { operator: req.user.name, quickReplies: QR_CLOSED });
    const updated = await ctx.tickets.update(ticket.id, { state: 'closed', resolved: true, closedAt: new Date() });
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
