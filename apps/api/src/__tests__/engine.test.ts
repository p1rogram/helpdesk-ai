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

/** AI: Модель по сценарию: возвращает заготовленные анализы, стримит фиксированное решение. */
class FakeLlm extends LlmService {
  queue: Array<Partial<Analysis> | Error> = [];
  constructor() {
    super({
      model: 'fake',
      baseURL: 'http://localhost',
      effort: 'low',
      timeoutMs: 1000,
      log: { warn() {}, debug() {} },
    });
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
  return {
    events,
    text: done.message.content,
    ticket: done.ticket,
    quick: done.message.quickReplies ?? [],
  };
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
    rag: null,
    llm,
    tickets,
    events: bus,
    helpdesk: new NoopHelpdesk(),
    config: {
      maxClarifications: 2,
      confidenceThreshold: 0.6,
      historyTurns: 6,
      dailyRequestLimit: 4,
      dailyHumanLimit: 3,
    },
    log: { info() {}, warn() {} },
  });
});

afterAll(async () => handle.close());

async function fresh() {
  const user = await tickets.upsertUser('web', `u-${Math.random()}`, 'Тест');
  const ticket = await tickets.create('tpu', user.id);
  return { user, ticket };
}

/** AI: A ticket that already reached a specialist: problem -> solution shown -> "a human, please". */
async function escalated() {
  const { user, ticket } = await fresh();
  llm.queue.push({ fields: { location: 'Из корпуса' } });
  await collect(engine.handle(ticket, user, 'VPN не работает'));
  const t2 = (await tickets.get(ticket.id, user.id))!;
  llm.queue.push({ asksForHuman: true, categoryId: 'network', summary: 'Не подключается VPN' });
  const r = await collect(engine.handle(t2, user, 'Позовите специалиста'));
  expect(r.ticket.state).toBe('escalated');
  return { user, ticket, r };
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

    // AI: Вариант из кнопки отвечает на ожидаемое поле детерминированно - модель не вызывается.
    const t2 = (await tickets.get(ticket.id, user.id))!;
    const r2 = await collect(engine.handle(t2, user, 'Из дома / удалённо'));
    expect(llm.queue.length).toBe(0);
    expect(r2.ticket.state).toBe('solving');
    expect(r2.ticket.articleId).toMatch(/^network-vpn/);
    expect(r2.text).toContain('Шаг из модели');
    expect(r2.quick.map((q) => q.value)).toEqual([CMD.helped, CMD.notHelped, CMD.human]);
    // AI: Задан ровно один уточняющий вопрос - второе поле необязательное.
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
    expect(published.some((e) => e.type === 'ticket.resolved' && e.ticketId === ticket.id)).toBe(
      true,
    );
  });

  it('tries to solve first; hands over only after a solution was shown', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({
      asksForHuman: true,
      categoryId: 'network',
      summary: 'Не подключается VPN',
      fields: { location: 'Из дома / удалённо' },
    });
    const r1 = await collect(
      engine.handle(ticket, user, 'Позовите живого человека, VPN не работает из дома'),
    );
    // AI: Not a request yet: the assistant promises a specialist if this does not help, and tries.
    expect(r1.ticket.state).toBe('solving');
    expect(r1.text).toMatch(/сначала попробую помочь/);
    expect(r1.quick.map((q) => q.value)).toEqual([CMD.helped, CMD.notHelped, CMD.human]);

    const t2 = (await tickets.get(ticket.id, user.id))!;
    const r2 = await collect(engine.handle(t2, user, CMD.human));
    expect(r2.ticket.state).toBe('escalated');
    expect(r2.text).toMatch(/Заявка №/);
    expect(r2.ticket.externalId).toBeTruthy();
  });

  it('collects the required fields before handing over, without a second model call', async () => {
    const { user, ticket } = await fresh();
    // AI: The solution was shown without the role (clarification budget spent); the hand-over asks it.
    await tickets.update(ticket.id, { clarificationsAsked: 2 });
    llm.queue.push({ categoryId: 'account', summary: 'Заблокирован аккаунт' });
    const t1 = (await tickets.get(ticket.id, user.id))!;
    const r0 = await collect(engine.handle(t1, user, 'заблокировали аккаунт'));
    expect(r0.ticket.state).toBe('solving');
    await tickets.update(ticket.id, { clarificationsAsked: 0 });

    const t2 = (await tickets.get(ticket.id, user.id))!;
    const r1 = await collect(engine.handle(t2, user, CMD.human));
    expect(r1.ticket.state).toBe('clarifying');
    expect(r1.text).toMatch(/Передам специалисту/);
    expect(r1.quick.map((q) => q.label)).toContain('Студент');

    const t3 = (await tickets.get(ticket.id, user.id))!;
    const r2 = await collect(engine.handle(t3, user, 'Студент'));
    expect(llm.queue.length).toBe(0);
    expect(r2.ticket.state).toBe('escalated');
    expect(r2.ticket.fields.role).toBe('Студент');
    expect(r2.text).not.toMatch(/Не уточнено/);
  });

  it('hands over after the clarification limit even when the data is still missing', async () => {
    const { user, ticket } = await fresh();
    await tickets.update(ticket.id, { clarificationsAsked: 2 });
    llm.queue.push({ categoryId: 'account', summary: 'Заблокирован аккаунт' });
    const t1 = (await tickets.get(ticket.id, user.id))!;
    await collect(engine.handle(t1, user, 'заблокировали аккаунт'));
    const t2 = (await tickets.get(ticket.id, user.id))!;
    const r = await collect(engine.handle(t2, user, CMD.human));
    expect(r.ticket.state).toBe('escalated');
    expect(r.text).toMatch(/Не уточнено: Кто обращается/);
  });

  it('lets the user withdraw a request that is with a specialist - after a confirmation', async () => {
    const { user, ticket } = await escalated();

    // AI: "No longer relevant" is not closed on a guess - the assistant asks.
    const t2 = (await tickets.get(ticket.id, user.id))!;
    const r2 = await collect(engine.handle(t2, user, 'уже не актуально, разобрался'));
    expect(r2.ticket.state).toBe('escalated');
    expect(r2.quick.map((q) => q.value)).toEqual([CMD.close, CMD.keep]);
    expect(llm.queue.length).toBe(0);

    const t3 = (await tickets.get(ticket.id, user.id))!;
    const r3 = await collect(engine.handle(t3, user, CMD.close));
    expect(r3.ticket.state).toBe('closed');
    expect(r3.ticket.closedBy).toBe('user');
    expect(r3.ticket.resolved).toBe(false); // withdrawn is not "solved" in the statistics
    expect(r3.ticket.escalated).toBe(true); // history still lists it under "Переданные"
    expect(r3.text).toMatch(/специалист уведомлён/);
    expect(published.some((e) => e.type === 'ticket.closed' && e.ticketId === ticket.id)).toBe(
      true,
    );
  });

  it('closes from the card button the same way as from the chat', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({ fields: { location: 'Из корпуса' } });
    await collect(engine.handle(ticket, user, 'VPN не работает'));
    const t2 = (await tickets.get(ticket.id, user.id))!;
    const r = await engine.closeByUser(t2, user);
    expect(r.ticket.state).toBe('closed');
    expect(r.ticket.closedBy).toBe('user');
    expect(r.message.role).toBe('assistant');
    const msgs = await tickets.listMessages(ticket.id, 50);
    expect(msgs[msgs.length - 2]!.content).toBe('Закрыть обращение');
  });

  it('asks for the room in a dorm and refuses a building that does not exist', async () => {
    const { user, ticket } = await fresh();
    // AI: Модель скопировала в поля несуществующий корпус - он не должен выжить.
    llm.queue.push({
      categoryId: 'campus',
      summary: 'Нет света',
      fields: { building: 'корпус 40' },
    });
    const r1 = await collect(engine.handle(ticket, user, 'в корпусе 40 нет света'));
    expect(r1.ticket.fields.building).toBeUndefined();
    expect(r1.text).toMatch(/корпуса №40 в ТПУ нет/);

    const t2 = (await tickets.get(ticket.id, user.id))!;
    const r2 = await collect(engine.handle(t2, user, 'ой, общежитие 12'));
    llm.queue.push({ categoryId: 'campus', summary: 'Нет света', fields: {} });
    expect(r2.ticket.fields.building).toBe('общежитие №12');
    // проблема в общежитии требует комнату; для корпуса не требуется
    expect(r2.ticket.state).toBe('clarifying');
    expect(r2.ticket.state === 'clarifying' && r2.text).toMatch(/комнат/);
  });

  it('does not hand over to a specialist a building that does not exist', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({
      asksForHuman: true,
      categoryId: 'campus',
      summary: 'Сломана дверь',
      fields: {},
    });
    const r = await collect(
      engine.handle(ticket, user, 'позовите человека, корпус 99, дверь сломана'),
    );
    expect(r.ticket.state).toBe('clarifying');
    expect(r.ticket.escalated).toBe(false);
    expect(r.text).toMatch(/корпуса №99 в ТПУ нет/);
  });

  it('asks what happened when a human is requested before any problem is named', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({
      asksForHuman: true,
      categoryId: 'unknown',
      confidence: 0,
      summary: 'Пользователь просит связать с оператором',
    });
    const r1 = await collect(engine.handle(ticket, user, 'Свяжи с оператором'));
    expect(r1.ticket.state).toBe('intake');
    expect(r1.ticket.escalated).toBe(false);
    expect(r1.ticket.summary).toBeNull(); // "wants an operator" is not a problem statement
    expect(r1.text).toMatch(/опишите, что случилось/i);

    // AI: The description arrives: the assistant solves first, as promised; no request yet.
    const t2 = (await tickets.get(ticket.id, user.id))!;
    llm.queue.push({
      categoryId: 'account',
      confidence: 0.9,
      summary: 'Заблокирован аккаунт',
      fields: { role: 'Студент' },
    });
    const r2 = await collect(engine.handle(t2, user, 'заблокировали аккаунт, я студент'));
    expect(r2.ticket.state).toBe('solving');
    expect(r2.ticket.categoryId).toBe('account');
    expect(r2.ticket.summary).toBe('Заблокирован аккаунт');

    const t3 = (await tickets.get(ticket.id, user.id))!;
    const r3 = await collect(engine.handle(t3, user, CMD.human));
    expect(r3.ticket.state).toBe('escalated');
  });

  it('stops repeated calls for a human at the daily limit and keeps solving instead', async () => {
    const { user, ticket } = await fresh();
    const ask = { asksForHuman: true, categoryId: 'unknown', confidence: 0, summary: '' };
    for (let i = 0; i < 3; i++) {
      llm.queue.push(ask);
      const t = (await tickets.get(ticket.id, user.id))!;
      const r = await collect(engine.handle(t, user, 'позовите оператора'));
      expect(r.ticket.escalated).toBe(false);
    }
    llm.queue.push(ask);
    const t = (await tickets.get(ticket.id, user.id))!;
    const r = await collect(engine.handle(t, user, 'позовите оператора'));
    expect(r.text).toMatch(/3 раза звали специалиста/);
    expect(r.ticket.escalated).toBe(false);
  });

  it('caps requests per day for a regular user, never for an operator', async () => {
    const { user, ticket } = await fresh();
    for (let i = 0; i < 4; i++) await tickets.bumpCounter(user.id, 'requests');
    llm.queue.push({ fields: { location: 'Из корпуса' } });
    await collect(engine.handle(ticket, user, 'VPN не работает'));
    const t2 = (await tickets.get(ticket.id, user.id))!;
    const r = await collect(engine.handle(t2, user, CMD.human));
    expect(r.ticket.state).toBe('solving');
    expect(r.text).toMatch(/4 заявки специалисту - это дневной лимит/);

    const t3 = (await tickets.get(ticket.id, user.id))!;
    const op = await collect(engine.handle(t3, { ...user, operator: true }, CMD.human));
    expect(op.ticket.state).toBe('escalated');
  });

  it('splits several problems from one message into separate requests, one at a time', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({
      categoryId: 'network',
      confidence: 0.5,
      summary: 'VPN и вода',
      problems: ['Не работает VPN из дома', 'В общежитии 12 нет горячей воды'],
    });
    const r1 = await collect(
      engine.handle(ticket, user, 'не работает VPN из дома, и ещё в общаге 12 нет горячей воды'),
    );
    expect(r1.ticket.state).toBe('intake');
    expect(r1.ticket.pendingProblems).toHaveLength(2);
    expect(r1.quick.map((q) => q.value)).toEqual([`${CMD.pick}0`, `${CMD.pick}1`]);

    // AI: Выбрана первая проблема: модель видит только её, вторая ждёт.
    llm.queue.push({ categoryId: 'network', confidence: 0.9, summary: 'Не работает VPN из дома' });
    const t2 = (await tickets.get(ticket.id, user.id))!;
    const r2 = await collect(engine.handle(t2, user, `${CMD.pick}0`));
    expect(r2.ticket.categoryId).toBe('network');
    expect(r2.ticket.pendingProblems).toEqual(['В общежитии 12 нет горячей воды']);
    expect(r2.ticket.state).toBe('solving'); // "из дома" was extracted, no clarification needed

    const t3 = (await tickets.get(ticket.id, user.id))!;
    const r3 = await collect(engine.handle(t3, user, CMD.helped));
    expect(r3.ticket.state).toBe('closed');
    expect(r3.text).toMatch(/Остался ещё вопрос/);
    expect(r3.quick.map((q) => q.value)).toEqual([CMD.next]);

    // AI: «Следующий» открывает новое обращение со второй проблемой; закрытое остаётся закрытым.
    llm.queue.push({ categoryId: 'campus', confidence: 0.9, summary: 'Нет горячей воды' });
    const t4 = (await tickets.get(ticket.id, user.id))!;
    const r4 = await collect(engine.handle(t4, user, CMD.next));
    expect(r4.ticket.id).not.toBe(ticket.id);
    expect(r4.ticket.categoryId).toBe('campus');
    expect(r4.ticket.pendingProblems).toEqual([]);
    expect((await tickets.get(ticket.id, user.id))!.state).toBe('closed');
  });

  it('answers a follow-up question in the middle of a sentence while a solution is shown', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({ fields: { location: 'Из корпуса' } });
    await collect(engine.handle(ticket, user, 'VPN не работает'));
    const t2 = (await tickets.get(ticket.id, user.id))!;
    llm.queue.push({ categoryId: 'general', confidence: 0.8, summary: 'Где столовые' });
    const r = await collect(engine.handle(t2, user, 'в каких корпусах есть столовые'));
    expect(r.text).not.toMatch(/^Учёл/);
    expect(r.text).toMatch(/кафе|столов/i);
  });

  it('asks for everything it needs in one message, then only for what is still missing', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({ categoryId: 'access', confidence: 0.9, summary: 'Нужен доступ', fields: {} });
    const r1 = await collect(engine.handle(ticket, user, 'мне нужен доступ'));
    expect(r1.ticket.state).toBe('clarifying');
    expect(r1.ticket.pendingFields).toEqual(['role', 'resource']);
    expect(r1.text).toMatch(/уточните:/);
    expect(r1.text).toMatch(/студент или сотрудник/i);
    expect(r1.text).toMatch(/какому ресурсу/i);
    expect(r1.quick.map((q) => q.label)).toEqual(['Студент', 'Сотрудник']); // buttons for the option field

    // AI: One answer covers one question; the raw text is not written into the other field.
    const t2 = (await tickets.get(ticket.id, user.id))!;
    llm.queue.push({ categoryId: 'access', confidence: 0.9, summary: 'Нужен доступ', fields: {} });
    const r2 = await collect(engine.handle(t2, user, 'я студент'));
    expect(r2.ticket.fields).toEqual({ role: 'Студент' });
    expect(r2.ticket.pendingFields).toEqual(['resource']);
    expect(r2.text).toMatch(/^Осталось уточнить: к какому ресурсу/);

    // AI: The last open question takes a free-form answer as is.
    const t3 = (await tickets.get(ticket.id, user.id))!;
    llm.queue.push({ categoryId: 'access', confidence: 0.9, summary: 'Нужен доступ', fields: {} });
    const r3 = await collect(engine.handle(t3, user, 'пропуск в 8 корпус'));
    expect(r3.ticket.fields.resource).toBe('пропуск в 8 корпус');
    expect(r3.ticket.state).toBe('solving');
  });

  it('treats a short campus-life question as a real request (catalog, model down)', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push(new LlmUnavailableError('down'));
    const r = await collect(engine.handle(ticket, user, 'есть столовая?'));
    expect(r.ticket.categoryId).toBe('general');
    expect(r.ticket.state).toBe('solving');
    expect(r.ticket.articleId).toBe('general-food');
    expect(r.text).toMatch(/кафе|столов/i);
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
    // AI: Категория известна, но в базе знаний ничего не подходит -> помощник спрашивает, а не
    // передаёт.
    llm.queue.push({
      categoryId: 'general',
      confidence: 0.9,
      summary: 'Спор с соседом по комнате из-за шума ночью',
      fields: {},
    });
    const r1 = await collect(
      engine.handle(ticket, user, 'Сосед по общаге шумит ночью, что делать?'),
    );
    if (r1.ticket.state === 'offer_escalation') {
      expect(r1.ticket.escalated).toBe(false);
      expect(r1.quick.map((q) => q.value)).toEqual([CMD.escalate, CMD.dismiss]);
      const t2 = (await tickets.get(ticket.id, user.id))!;
      const r2 = await collect(engine.handle(t2, user, CMD.dismiss));
      expect(r2.ticket.state).toBe('intake');
      expect(r2.ticket.escalated).toBe(false);
    } else {
      // AI: Статья базы знаний подошла - заявка всё равно не создана без вопроса.
      expect(r1.ticket.escalated).toBe(false);
    }
  });

  it('never lets a guest reach a specialist: no request, no operator, no such buttons', async () => {
    const { user, ticket } = await fresh();
    // AI: просьба позвать человека свободным текстом
    llm.queue.push({ asksForHuman: true, categoryId: 'general', summary: 'Хочет оператора' });
    const r1 = await collect(engine.handle(ticket, user, 'Позовите оператора', 'guest'));
    expect(r1.ticket.state).not.toBe('escalated');
    expect(r1.ticket.escalated).toBe(false);
    expect(r1.text).toMatch(/гостевом режиме/);
    // AI: команды-кнопки тоже отклоняются
    for (const cmd of [CMD.human, CMD.escalate]) {
      const t = (await tickets.get(ticket.id, user.id))!;
      const r = await collect(engine.handle(t, user, cmd, 'guest'));
      expect(r.ticket.escalated).toBe(false);
      expect(r.quick.map((q) => q.value)).not.toContain(CMD.human);
      expect(r.quick.map((q) => q.value)).not.toContain(CMD.escalate);
    }
    // AI: тема без публичной статьи заканчивается контактами, а не предложением создать заявку
    const { user: u2, ticket: t2 } = await fresh();
    llm.queue.push({
      categoryId: 'general',
      confidence: 0.9,
      summary: 'Спор с соседом',
      fields: {},
    });
    const r2 = await collect(
      engine.handle(t2, u2, 'Сосед по общаге шумит ночью, что делать?', 'guest'),
    );
    expect(r2.ticket.state).not.toBe('offer_escalation');
    expect(r2.quick.map((q) => q.value)).not.toContain(CMD.escalate);
  });

  it('stays silent while an operator owns the ticket, and only acknowledges', async () => {
    const { user, ticket, r } = await escalated();
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
    // AI: Возврат оператором: помощник продолжает, передача по этому тикету запрещена.
    await tickets.update(ticket.id, { handledBy: 'ai', escalationBlocked: true, state: 'intake' });
    const t1 = (await tickets.get(ticket.id, user.id))!;
    const r1 = await collect(engine.handle(t1, user, CMD.human));
    expect(r1.ticket.state).not.toBe('escalated');
    expect(r1.ticket.escalated).toBe(false);
    expect(r1.text).toMatch(/специалист уже принял решение/i);

    // AI: Даже явное «хочу человека» из анализа отклоняется.
    llm.queue.push({ asksForHuman: true, categoryId: 'account', summary: 'x' });
    const t2 = (await tickets.get(ticket.id, user.id))!;
    const r2 = await collect(engine.handle(t2, user, 'Хочу живого человека'));
    expect(r2.ticket.escalated).toBe(false);
  });

  it('never answers an off-topic question, even if the model tried to', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({
      offTopic: true,
      categoryId: 'unknown',
      confidence: 0,
      summary: '',
      smalltalkReply:
        'Две буквы «р». Но давайте вернёмся к делу: если что-то не работает, расскажите.',
    });
    const r = await collect(engine.handle(ticket, user, 'А сколько букв р в слове троллейбус'));
    expect(r.text).not.toMatch(/букв/);
    expect(r.text).toMatch(/помочь|не работает|разберёмся/);
    expect(r.ticket.summary).toBeNull();
  });

  it('uses the model-written smalltalk reply for off-topic messages', async () => {
    const { user, ticket } = await fresh();
    llm.queue.push({
      offTopic: true,
      categoryId: 'unknown',
      confidence: 0,
      summary: '',
      smalltalkReply: 'Хех, стихи — не мой профиль. Что сломалось?',
    });
    const r = await collect(engine.handle(ticket, user, 'напиши стих про кота'));
    expect(r.text).toBe('Хех, стихи — не мой профиль. Что сломалось?');
    expect(r.ticket.summary).toBeNull();
  });
});
