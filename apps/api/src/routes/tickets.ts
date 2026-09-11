import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RateRequestSchema, SendMessageRequestSchema, TOPICS, type ChatStreamEvent } from '@helpdesk/shared';
import type { AppContext } from '../context.js';
import { eventBase } from '../modules/events/index.js';
import { toCard, toChatMessage } from '../modules/tickets/repository.js';
import { QR_CLOSED, T } from '../modules/dialog/templates.js';

const IdParam = z.object({ id: z.string().uuid() });

export async function ticketRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  /**
   * AI: Open the current ticket: reuse the latest open one (so re-opening the app or switching tabs
   * never spawns empty tickets); `?new=1` forces a fresh one. Abandoned empty tickets are pruned.
   */
  app.post('/api/tickets', async (req) => {
    const catalog = await ctx.knowledge.catalog(req.user.tenant, req.user.scope ?? 'full');
    const forceNew = z.object({ new: z.string().optional() }).parse(req.query ?? {}).new === '1';
    const existing = forceNew ? undefined : await ctx.tickets.latestOpen(req.user.sub);
    if (existing && existing.tenantId === req.user.tenant) {
      const msgs = await ctx.tickets.listMessages(existing.id, 200);
      return { ticket: toCard(existing, catalog), messages: msgs.map(toChatMessage) };
    }
    await ctx.tickets.pruneEmpty(req.user.sub);
    const ticket = await ctx.tickets.create(req.user.tenant, req.user.sub);
    const greeting = await ctx.tickets.addMessage(ticket.id, 'assistant', T.greeting(catalog.sphere), { quickReplies: [] });
    await ctx.events.publish(TOPICS.ticketEvents, ticket.id, {
      ...eventBase(ticket.id, req.user.sub),
      type: 'ticket.created',
      ticket: toCard(ticket, catalog),
    });
    return { ticket: toCard(ticket, catalog), messages: [toChatMessage(greeting)] };
  });

  /** AI: History of the user - "вернуться к предыдущему обращению". */
  app.get('/api/tickets', async (req) => {
    const catalog = await ctx.knowledge.catalog(req.user.tenant, req.user.scope ?? 'full');
    const rows = await ctx.tickets.listForUser(req.user.sub, 30);
    // AI: Hide tickets that never got a problem statement (greeting only).
    return { tickets: rows.filter((t) => t.summary || t.state !== 'intake').map((t) => toCard(t, catalog)) };
  });

  app.get('/api/tickets/:id', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ticket = await ctx.tickets.get(id, req.user.sub);
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    const catalog = await ctx.knowledge.catalog(ticket.tenantId);
    const msgs = await ctx.tickets.listMessages(ticket.id, 200);
    return { ticket: toCard(ticket, catalog), messages: msgs.map(toChatMessage) };
  });

  /** AI: Send a message; the answer streams back as Server-Sent Events. */
  app.post('/api/tickets/:id/messages', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = SendMessageRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
    const ticket = await ctx.tickets.get(id, req.user.sub);
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    const user = (await ctx.tickets.getUser(req.user.sub))!;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': (req.headers.origin as string) ?? '*',
    });
    const send = (ev: ChatStreamEvent) => reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    try {
      for await (const ev of ctx.engine.handle(ticket, user, body.data.text, req.user.scope ?? 'full')) send(ev);
    } catch (err) {
      req.log.error(err, 'dialog engine failed');
      send({ type: 'error', message: 'Не удалось обработать сообщение. Попробуйте ещё раз.' });
    } finally {
      clearInterval(heartbeat);
      reply.raw.end();
    }
    return reply;
  });

  /** AI: Rate the answer (1..5) - "оценка ответа". */
  app.post('/api/tickets/:id/rating', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = RateRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
    const ticket = await ctx.tickets.get(id, req.user.sub);
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    const updated = await ctx.tickets.update(ticket.id, {
      rating: body.data.rating,
      ratingComment: body.data.comment ?? null,
    });
    await ctx.events.publish(TOPICS.ticketEvents, ticket.id, {
      ...eventBase(ticket.id, req.user.sub),
      type: 'ticket.rated',
      rating: body.data.rating,
      ...(body.data.comment ? { comment: body.data.comment } : {}),
    });
    const catalog = await ctx.knowledge.catalog(ticket.tenantId);
    return { ticket: toCard(updated, catalog), quickReplies: QR_CLOSED };
  });
}
