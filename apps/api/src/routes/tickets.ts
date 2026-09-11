import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  RateRequestSchema,
  SendMessageRequestSchema,
  TOPICS,
  type ChatStreamEvent,
} from '@helpdesk/shared';
import type { AppContext } from '../context.js';
import { eventBase } from '../modules/events/index.js';
import { toCard, toChatMessage } from '../modules/tickets/repository.js';
import { QR_CLOSED, T } from '../modules/dialog/templates.js';

/**
 * AI: Самый долгий проход движка, который мы терпим, прежде чем другой запрос сможет перехватить
 * тикет.
 */
const LEASE_MS = 90_000;

const IdParam = z.object({ id: z.string().uuid() });

export async function ticketRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  /** AI: Операторы не ограничены дневными лимитами на заявки и вызовы специалиста. */
  const isOperator = (req: FastifyRequest): boolean =>
    req.user.scope !== 'guest' &&
    (ctx.config.OPERATOR_OPEN_ACCESS ||
      ctx.config.adminUsers.has(`${req.user.platform}:${req.user.puid}`) ||
      (req.user.roles?.includes('operator') ?? false));

  /**
   * AI: Открыть текущий тикет: переиспользуем последний открытый (чтобы повторное открытие
   * приложения или переключение вкладок не плодило пустые тикеты); `?new=1` создаёт новый.
   * Брошенные пустые тикеты удаляются.
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
    const greeting = await ctx.tickets.addMessage(
      ticket.id,
      'assistant',
      T.greeting(catalog.sphere),
      { quickReplies: [] },
    );
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
    // AI: Скрываем тикеты, в которых так и не появилось описания проблемы (только приветствие).
    return {
      tickets: rows.filter((t) => t.summary || t.state !== 'intake').map((t) => toCard(t, catalog)),
    };
  });

  app.get('/api/tickets/:id', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ticket = await ctx.tickets.get(id, req.user.sub);
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    const catalog = await ctx.knowledge.catalog(ticket.tenantId);
    const msgs = await ctx.tickets.listMessages(ticket.id, 200);
    return { ticket: toCard(ticket, catalog), messages: msgs.map(toChatMessage) };
  });

  /**
   * AI: Отправить сообщение; ответ стримится как Server-Sent Events. Одно сообщение на тикет за
   * раз: двойной тап по «отправить» не должен запускать два прохода движка по одному состоянию.
   * Аренда живёт в базе, поэтому действует между репликами API и истекает, если процесс умер.
   */
  app.post('/api/tickets/:id/messages', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = SendMessageRequestSchema.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
    const ticket = await ctx.tickets.get(id, req.user.sub);
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    if (!(await ctx.tickets.tryLock(ticket.id, LEASE_MS)))
      return reply.code(409).send({ error: 'busy' });
    const user = { ...(await ctx.tickets.getUser(req.user.sub))!, operator: isOperator(req) };

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...sseCors(req.headers.origin, ctx.config.corsOrigins),
    });
    const send = (ev: ChatStreamEvent) => reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    try {
      for await (const ev of ctx.engine.handle(
        ticket,
        user,
        body.data.text,
        req.user.scope ?? 'full',
      ))
        send(ev);
    } catch (err) {
      req.log.error(err, 'dialog engine failed');
      send({ type: 'error', message: 'Не удалось обработать сообщение. Попробуйте ещё раз.' });
    } finally {
      await ctx.tickets.unlock(ticket.id).catch(() => undefined);
      clearInterval(heartbeat);
      reply.raw.end();
    }
    return reply;
  });

  /**
   * AI: Пользователь отзывает обращение («уже не актуально») - разрешено в любом состоянии, в том
   * числе пока оно у специалиста; консоль и helpdesk уведомляет движок.
   */
  app.post('/api/tickets/:id/close', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ticket = await ctx.tickets.get(id, req.user.sub);
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    if (ticket.state === 'closed') return reply.code(409).send({ error: 'already_closed' });
    if (!(await ctx.tickets.tryLock(ticket.id, LEASE_MS)))
      return reply.code(409).send({ error: 'busy' });
    try {
      const user = (await ctx.tickets.getUser(req.user.sub))!;
      const closed = await ctx.engine.closeByUser(ticket, user, req.user.scope ?? 'full');
      ctx.operatorHub.notify(ticket.tenantId, ticket.id);
      return closed;
    } finally {
      await ctx.tickets.unlock(ticket.id).catch(() => undefined);
    }
  });

  /** AI: Rate the answer (1..5) - "оценка ответа". */
  app.post('/api/tickets/:id/rating', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = RateRequestSchema.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
    const ticket = await ctx.tickets.get(id, req.user.sub);
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    if (ticket.state !== 'closed') return reply.code(409).send({ error: 'not_closed' });
    if (ticket.rating !== null) return reply.code(409).send({ error: 'already_rated' });
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
    // AI: Подтверждение - настоящее сообщение в чате, чтобы результат оценки был виден - и сейчас,
    // и при открытии тикета из истории.
    const thanks = await ctx.tickets.addMessage(ticket.id, 'assistant', T.rated(body.data.rating), {
      rating: body.data.rating,
      quickReplies: QR_CLOSED,
    });
    const catalog = await ctx.knowledge.catalog(ticket.tenantId);
    return { ticket: toCard(updated, catalog), message: toChatMessage(thanks) };
  });
}

/**
 * AI: SSE обходит CORS-плагин (сырой ответ), поэтому белый список применяется здесь вручную.
 * Same-origin запросы без заголовка Origin ничего не требуют.
 */
export function sseCors(origin: string | undefined, allowed: string[]): Record<string, string> {
  return origin && allowed.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : {};
}
