import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TOPICS } from '@helpdesk/shared';
import type { AppContext } from '../context.js';
import { eventBase } from '../modules/events/index.js';
import { toCard, toChatMessage } from '../modules/tickets/repository.js';
import { QR_CLOSED, QR_AFTER_SOLUTION, QR_ESCALATED, T } from '../modules/dialog/templates.js';
import { sseCors } from './tickets.js';

const IdParam = z.object({ id: z.string().uuid() });
const ReplySchema = z.object({ text: z.string().trim().min(1).max(4000) });

/**
 * AI: Консоль оператора: встроенная «сторона специалиста». Переданные тикеты попадают сюда;
 * оператор отвечает в чат пользователя (push через топик уведомлений) и закрывает тикет. Только для
 * операторов (ADMIN_USERS или группа операторов). Внешний helpdesk (Naumen) может заменить или
 * дополнить её.
 */
export async function operatorRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', app.requireOperator);

  /**
   * AI: Рабочий список, уже сгруппированный: 0 - диалоги самого оператора, 1 - ждут первого ответа
   * (самое долгое ожидание первым), 2 - закрытые.
   */
  app.get('/api/operator/tickets', async (req) => {
    const rows = await ctx.tickets.listForOperator(req.user.tenant, req.user.sub, 150);
    const catalog = await ctx.knowledge.catalog(req.user.tenant);
    return {
      tickets: rows.map((r) => ({
        ...toCard(r.ticket, catalog),
        user: { displayName: r.user.displayName, platform: r.user.platform },
        lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
        unanswered: r.unanswered,
        group: r.group,
      })),
      me: req.user.name,
    };
  });

  /** AI: Сводка: сегодня / 7 дней, кто закрыл, средняя оценка, длина очереди. */
  app.get('/api/operator/stats', async (req) => ctx.tickets.operatorStats(req.user.tenant));

  /** AI: Взять обращение себе: остальные видят, что оно в работе у коллеги. */
  app.post('/api/operator/tickets/:id/assign', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ticket = await ctx.tickets.getAny(id);
    if (!ticket || ticket.tenantId !== req.user.tenant)
      return reply.code(404).send({ error: 'not_found' });
    if (ticket.state !== 'escalated') return reply.code(409).send({ error: 'not_escalated' });
    const updated = await ctx.tickets.update(ticket.id, {
      assignedTo: req.user.name,
      assignedToId: req.user.sub,
    });
    ctx.operatorHub.notify(ticket.tenantId, ticket.id);
    const catalog = await ctx.knowledge.catalog(ticket.tenantId);
    return { ticket: toCard(updated, catalog) };
  });

  /** AI: Рабочие заметки специалиста - пользователю не видны. */
  app.post('/api/operator/tickets/:id/notes', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = z.object({ text: z.string().max(4000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const ticket = await ctx.tickets.getAny(id);
    if (!ticket || ticket.tenantId !== req.user.tenant)
      return reply.code(404).send({ error: 'not_found' });
    await ctx.tickets.update(ticket.id, { operatorNotes: body.data.text });
    return { ok: true };
  });

  /**
   * AI: Живые обновления очереди (SSE): новая передача или сообщение пользователя появляются без
   * перезагрузки. POST - основной способ (CDN-туннели буферизуют тела GET); GET остаётся для
   * EventSource / curl.
   */
  app.route({
    method: ['GET', 'POST'],
    url: '/api/operator/stream',
    config: { rateLimit: false },
    handler: async (req, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...sseCors(req.headers.origin, ctx.config.corsOrigins),
      });
      // AI: 2 КБ комментария-подушки: некоторые прокси (в том числе quick-туннели Cloudflare)
      // держат первые байты chunked-ответа, пока не наполнится буфер; SSE-клиенты игнорируют строки
      // комментариев.
      reply.raw.write(`: ${' '.repeat(2048)}\n\n`);
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
    },
  });

  /**
   * AI: Вернуть тикет помощнику: оператор решил, что специалист не нужен. Помощник продолжает и
   * больше не имеет права передавать этот тикет.
   */
  app.post('/api/operator/tickets/:id/handback', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ticket = await ctx.tickets.getAny(id);
    if (!ticket || ticket.tenantId !== req.user.tenant)
      return reply.code(404).send({ error: 'not_found' });
    if (ticket.state !== 'escalated') return reply.code(409).send({ error: 'not_escalated' });
    const user = (await ctx.tickets.getUser(ticket.userId))!;
    const text = T.handedBackToAi();
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
    let ticket = await ctx.tickets.getAny(id);
    if (!ticket || ticket.tenantId !== req.user.tenant)
      return reply.code(404).send({ error: 'not_found' });
    // AI: Открытая переписка = «специалист прочитал»; пользователь видит это под чатом.
    if (ticket.state === 'escalated' && ticket.escalatedTo === 'operator')
      ticket = await ctx.tickets.update(ticket.id, { operatorReadAt: new Date() });
    const catalog = await ctx.knowledge.catalog(ticket.tenantId);
    const user = await ctx.tickets.getUser(ticket.userId);
    const msgs = await ctx.tickets.listMessages(ticket.id, 300);
    // AI: Что помощник уже предлагал и что не помогло - специалисту не нужно перечитывать чат.
    const tried = [
      ...new Set([...ticket.triedArticles, ...(ticket.articleId ? [ticket.articleId] : [])]),
    ]
      .map((a) => catalog.articleById.get(a)?.title)
      .filter((t): t is string => Boolean(t));
    return {
      ticket: toCard(ticket, catalog),
      user: user ? { displayName: user.displayName, platform: user.platform } : null,
      messages: msgs.map(toChatMessage),
      tried,
      notes: ticket.operatorNotes ?? '',
      escalationReason: ticket.escalationReason,
    };
  });

  /** AI: Ответ оператора -> сохраняется в чат, отправляется в мессенджер. */
  app.post('/api/operator/tickets/:id/reply', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = ReplySchema.safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
    const ticket = await ctx.tickets.getAny(id);
    if (!ticket || ticket.tenantId !== req.user.tenant)
      return reply.code(404).send({ error: 'not_found' });
    if (ticket.state !== 'escalated') return reply.code(409).send({ error: 'not_escalated' });
    const user = (await ctx.tickets.getUser(ticket.userId))!;
    const saved = await ctx.tickets.addMessage(ticket.id, 'assistant', body.data.text, {
      operator: req.user.name,
      quickReplies: QR_ESCALATED,
    });
    await ctx.tickets.update(ticket.id, {
      state: 'escalated',
      handledBy: 'operator',
      ...(ticket.assignedToId ? {} : { assignedTo: req.user.name, assignedToId: req.user.sub }),
    });
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

  /** AI: Закрыть как решённый оператором. */
  app.post('/api/operator/tickets/:id/close', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ticket = await ctx.tickets.getAny(id);
    if (!ticket || ticket.tenantId !== req.user.tenant)
      return reply.code(404).send({ error: 'not_found' });
    if (ticket.state === 'closed') return reply.code(409).send({ error: 'already_closed' });
    const user = (await ctx.tickets.getUser(ticket.userId))!;
    const closingText = `Специалист закрыл заявку как решённую. Если не сложно, оцените, как всё прошло — это помогает делать поддержку лучше. Если проблема повторится — создайте новое обращение.`;
    await ctx.tickets.addMessage(ticket.id, 'assistant', closingText, {
      operator: req.user.name,
      quickReplies: QR_CLOSED,
    });
    const updated = await ctx.tickets.update(ticket.id, {
      state: 'closed',
      resolved: true,
      closedBy: 'operator',
      closedByName: req.user.name,
      closedAt: new Date(),
    });
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
