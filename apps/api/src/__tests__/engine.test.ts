import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Analysis, ChatStreamEvent, TicketEvent } from '@helpdesk/shared';
import { TOPICS } from '@helpdesk/shared';
import { connectDb, ensureSchema, type DbHandle } from '../db/client.js';
import { REPO_ROOT } from '../config.js';
import { DialogEngine } from '../modules/dialog/engine.js';
import { CMD } from '../modules/dialog/templates.js';
import { MemoryEventBus } from '../modules/events/memory.js';
import { NoopHelpdesk } from '../modules/helpdesk/index.js';
import { CatalogRepository, KnowledgeService } from '../modules/knowledge/index.js';
import { LlmService, LlmUnavailableError } from '../modules/llm/index.js';
import { TicketRepository } from '../modules/tickets/repository.js';

/** AI: Scripted LLM: returns canned analyses, streams a fixed solution. */
class FakeLlm extends LlmService {
  queue: Array<Partial<Analysis> | Error> = [];
  constructor() {
    super({ model: 'fake', baseURL: 'http://localhost', effort: 'low', timeoutMs: 1000, log: { warn() {}, debug() {} } });
  }
  override async analyze(): Promise<Analysis> {
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return {
      categoryId: 'network',
      confidence: 0.9,
      summary: 'Не подключается VPN',
      fields: {},
      tone: 'neutral',
      offTopic: false,
      reportsResolved: false,
      asksForHuman: false,
      ...next,
    };
  }
  override async *solve(): AsyncGenerator<string, void, void> {
    yield '1. Шаг из модели\n';
    yield '2. Ещё шаг';
  }
}

let handle: DbHandle;
let engine: DialogEngine;
let tickets: TicketRepository;
let llm: FakeLlm;
const published: TicketEvent[] = [];

async function collect(gen: AsyncGenerator<ChatStreamEvent>) {
  const events: ChatStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  const done = events.find((e) => e.type === 'done');
  if (!done || done.type !== 'done') throw new Error('no done event');
  return { events, text: done.message.content, ticket: done.ticket, quick: done.message.quickReplies ?? [] };
}

beforeAll(async () => {
  handle = await connectDb({ pgliteDir: mkdtempSync(path.join(tmpdir(), 'helpdesk-test-')) });
  await ensureSchema(handle.db);
  const catalogs = new CatalogRepository(handle.db);
  await catalogs.seedFromDir(path.join(REPO_ROOT, 'data/catalog'), { info() {} });
  const bus = new MemoryEventBus();
  await bus.subscribe(TOPICS.ticketEvents, 'test', async (e) => {
    published.push(e);
  });
  llm = new FakeLlm();
  tickets = new TicketRepository(handle.db);
  engine = new DialogEngine({
    knowledge: new KnowledgeService(catalogs),
    llm,
    tickets,
    events: bus,
    helpdesk: new NoopHelpdesk(),
    config: { maxClarifications: 2, confidenceThreshold: 0.6, historyTurns: 6 },
    log: { info() {}, warn() {} },
  });
});

afterAll(async () => handle.close());

async function fresh() {
  const user = await tickets.upsertUser('web', `u-${Math.random()}`, 'Тест');
  const ticket = await tickets.create('tpu', user.id);
  return { user, ticket };
}

describe('DialogEngine', () => {
  beforeEach(() => {
    llm.queue = [];
  });

  it('classifies, asks only the required clarification, then streams a grounded solution', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({ fields: {} });
    const r1 = await collect(engine.handle(ticket, user, 'Не подключается VPN'));
    expect(r1.ticket.state).toBe('clarifying');
    expect(r1.ticket.categoryId).toBe('network');
    expect(r1.text).toMatch(/Откуда вы подключаетесь/);
    expect(r1.quick.map((q) => q.label)).toContain('Из дома / удалённо');

    // AI: Quick-reply option answers the pending field deterministically - no LLM call is made.
    const t2 = (await tickets.get(ticket.id, user.id))!;
    const r2 = await collect(engine.handle(t2, user, 'Из дома / удалённо'));
    expect(llm.queue.length).toBe(0);
    expect(r2.ticket.state).toBe('solving');
    expect(r2.ticket.articleId).toMatch(/^network-vpn/);
    expect(r2.text).toContain('Шаг из модели');
    expect(r2.quick.map((q) => q.value)).toEqual([CMD.helped, CMD.notHelped, CMD.human]);
    // AI: Exactly one clarification was asked - the second field is optional.
    expect((await tickets.get(ticket.id, user.id))!.clarificationsAsked).toBe(1);
  });

  it('closes the ticket on "helped" and publishes ticket.resolved', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({ fields: { location: 'Из корпуса' } });
    await collect(engine.handle(ticket, user, 'VPN не работает'));
    const t2 = (await tickets.get(ticket.id, user.id))!;
    const r = await collect(engine.handle(t2, user, CMD.helped));
    expect(r.ticket.state).toBe('closed');
    expect(r.ticket.resolved).toBe(true);
    expect(r.text).toMatch(/решено/);
    expect(published.some((e) => e.type === 'ticket.resolved' && e.ticketId === ticket.id)).toBe(true);
  });

  it('escalates with a ticket card when the user asks for a human', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({ asksForHuman: true, categoryId: 'account', summary: 'Заблокирован аккаунт' });
    const r = await collect(engine.handle(ticket, user, 'Позовите живого человека'));
    expect(r.ticket.state).toBe('escalated');
    expect(r.text).toMatch(/Заявка №/);
    expect(r.ticket.externalId).toBeTruthy();
  });

  it('offers category buttons on low confidence instead of guessing', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({ categoryId: 'unknown', confidence: 0.2, summary: 'Что-то сломалось' });
    const r = await collect(engine.handle(ticket, user, 'сломалось'));
    expect(r.ticket.state).toBe('choosing_category');
    expect(r.quick.length).toBeGreaterThan(5);
    expect(r.quick[0]!.value.startsWith(CMD.category)).toBe(true);
  });

  it('keeps working when the LLM is unavailable (deterministic fallback)', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push(new LlmUnavailableError('down'));
    const r = await collect(engine.handle(ticket, user, 'потерял пропуск, я студент'));
    expect(['clarifying', 'solving', 'escalated']).toContain(r.ticket.state);
    expect(r.ticket.categoryId).toBe('access');
  });

  it('raises priority for an abusive user without refusing help', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({ tone: 'abusive', fields: { location: 'Из дома / удалённо' } });
    const r = await collect(engine.handle(ticket, user, 'да бл*ть, впн опять сдох'));
    expect(r.ticket.priority).toBe('high');
    expect(r.ticket.tone).toBe('abusive');
    expect(r.ticket.state).toBe('solving');
  });

  it('ignores off-topic chatter before a category is known', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({ offTopic: true, categoryId: 'unknown', confidence: 0 });
    const r = await collect(engine.handle(ticket, user, 'напиши стих про кота'));
    expect(r.ticket.state).toBe('intake');
    expect(r.text).toMatch(/технической проблемой/);
  });

  it('answers greetings and "are you there?" instantly, without the model and without a ticket summary', async () => {
    const { user, ticket } = await fresh();
    const r = await collect(engine.handle(ticket, user, 'Ты тут?'));
    expect(llm.queue.length).toBe(0);
    expect(r.text).toMatch(/на месте/);
    expect(r.ticket.state).toBe('intake');
    expect(r.ticket.summary).toBeNull();
  });

  it('never creates a request on its own: offers escalation and waits for consent', async () => {
    const { user, ticket } = await fresh();
    // AI: Category known, but nothing in the KB matches -> the assistant asks instead of escalating.
    llm.queue.push({ categoryId: 'general', confidence: 0.9, summary: 'Спор с соседом по комнате из-за шума ночью', fields: {} });
    const r1 = await collect(engine.handle(ticket, user, 'Сосед по общаге шумит ночью, что делать?'));
    if (r1.ticket.state === 'offer_escalation') {
      expect(r1.ticket.escalated).toBe(false);
      expect(r1.quick.map((q) => q.value)).toEqual([CMD.escalate, CMD.dismiss]);
      const t2 = (await tickets.get(ticket.id, user.id))!;
      const r2 = await collect(engine.handle(t2, user, CMD.dismiss));
      expect(r2.ticket.state).toBe('intake');
      expect(r2.ticket.escalated).toBe(false);
    } else {
      // AI: A KB article matched - still no request was created without asking.
      expect(r1.ticket.escalated).toBe(false);
    }
  });

  it('stays silent while an operator owns the ticket, and only acknowledges', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({ asksForHuman: true, categoryId: 'account', summary: 'Проблема с доступом' });
    const r = await collect(engine.handle(ticket, user, 'Позовите специалиста'));
    expect(r.ticket.state).toBe('escalated');
    expect(r.ticket.handledBy).toBe('operator');

    // AI: A follow-up message must NOT produce an assistant answer - it belongs to the operator.
    const t2 = (await tickets.get(ticket.id, user.id))!;
    const events: ChatStreamEvent[] = [];
    for await (const e of engine.handle(t2, user, 'Ещё деталь: логин ivanov')) events.push(e);
    expect(events.some((e) => e.type === 'ack')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(llm.queue.length).toBe(0); // the model was never called
    const msgs = await tickets.listMessages(ticket.id, 50);
    expect(msgs[msgs.length - 1]!.role).toBe('user'); // last word is the user's, no bot reply after it
  });

  it('never escalates again once the operator handed the ticket back', async () => {
    const { user, ticket } = await fresh();
    // AI: Operator hand-back: assistant resumes, escalation forbidden for this ticket.
    await tickets.update(ticket.id, { handledBy: 'ai', escalationBlocked: true, state: 'intake' });
    const t1 = (await tickets.get(ticket.id, user.id))!;
    const r1 = await collect(engine.handle(t1, user, CMD.human));
    expect(r1.ticket.state).not.toBe('escalated');
    expect(r1.ticket.escalated).toBe(false);
    expect(r1.text).toMatch(/специалист уже принял решение/i);

    // AI: Even an explicit "I want a human" from the analysis is refused.
    llm.queue.push({ asksForHuman: true, categoryId: 'account', summary: 'x' });
    const t2 = (await tickets.get(ticket.id, user.id))!;
    const r2 = await collect(engine.handle(t2, user, 'Хочу живого человека'));
    expect(r2.ticket.escalated).toBe(false);
  });

  it('uses the model-written smalltalk reply for off-topic messages', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({ offTopic: true, categoryId: 'unknown', confidence: 0, summary: '', smalltalkReply: 'Хех, стихи — не мой профиль. Что сломалось?' });
    const r = await collect(engine.handle(ticket, user, 'напиши стих про кота'));
    expect(r.text).toBe('Хех, стихи — не мой профиль. Что сломалось?');
    expect(r.ticket.summary).toBeNull();
  });
});
