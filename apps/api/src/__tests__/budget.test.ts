import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Analysis, ChatStreamEvent } from '@helpdesk/shared';
import { connectDb, ensureSchema, type DbHandle } from '../db/client.js';
import { REPO_ROOT } from '../config.js';
import { DialogEngine } from '../modules/dialog/engine.js';
import { MemoryEventBus } from '../modules/events/memory.js';
import { NoopHelpdesk } from '../modules/helpdesk/index.js';
import { CatalogRepository, KnowledgeService } from '../modules/knowledge/index.js';
import { LlmService } from '../modules/llm/index.js';
import { TicketRepository } from '../modules/tickets/repository.js';
import { WindowCounters } from '../modules/usage/counters.js';
import { LlmBudget } from '../modules/usage/budget.js';

/** AI: «Включённая» модель, которая считает вызовы analyze - чтобы видеть, дошёл ли запрос до неё. */
class CountingLlm extends LlmService {
  calls = 0;
  constructor() {
    super({
      apiKey: 'fake-key',
      model: 'fake',
      baseURL: 'http://localhost',
      effort: 'low',
      timeoutMs: 1000,
      log: { warn() {}, debug() {} },
    });
  }
  override async analyze(): Promise<Analysis> {
    this.calls++;
    return {
      categoryId: 'admission',
      confidence: 0.9,
      summary: 'Сроки подачи документов',
      fields: {},
      tone: 'neutral',
      offTopic: false,
      reportsResolved: false,
      asksForHuman: false,
      informational: true,
    };
  }
  override async *solve(): AsyncGenerator<string, void, void> {
    yield 'Ответ модели';
  }
  override async *answer(): AsyncGenerator<string, void, void> {
    yield 'Ответ модели';
  }
}

let handle: DbHandle;
let tickets: TicketRepository;
let counters: WindowCounters;
let llm: CountingLlm;
let knowledge: KnowledgeService;

function makeEngine(budget: LlmBudget) {
  return new DialogEngine({
    knowledge,
    rag: null,
    llm,
    budget,
    tickets,
    events: new MemoryEventBus(),
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
}

async function collect(gen: AsyncGenerator<ChatStreamEvent>) {
  let text = '';
  for await (const e of gen) if (e.type === 'done') text = e.message.content;
  return text;
}

async function guest(id: string) {
  const user = await tickets.upsertUser('web', `guest:${id}`, 'Гость');
  const ticket = await tickets.create('tpu', user.id);
  return { user, ticket };
}

beforeAll(async () => {
  handle = await connectDb({ pgliteDir: mkdtempSync(path.join(tmpdir(), 'helpdesk-budget-')) });
  await ensureSchema(handle.db);
  const catalogs = new CatalogRepository(handle.db);
  await catalogs.seedFromDir(path.join(REPO_ROOT, 'data/catalog'), { info() {} });
  knowledge = new KnowledgeService(catalogs);
  tickets = new TicketRepository(handle.db);
  counters = new WindowCounters(handle.db);
  llm = new CountingLlm();
});
afterAll(async () => handle.close());

describe('guest LLM budget', () => {
  it('gives the model to a guest device only within its hourly budget, then answers without it', async () => {
    const budget = new LlmBudget(counters, {
      guestPerHour: 2,
      guestPerDay: 30,
      guestIpPerHour: 60,
      dailyTokenBudget: 0,
    });
    const engine = makeEngine(budget);
    const key = { device: 'dev-a', ip: '10.0.0.1' };
    const before = llm.calls;

    const { user, ticket } = await guest('a');
    await collect(engine.handle(ticket, user, 'Когда подавать документы?', 'guest', key));
    await collect(engine.handle(ticket, user, 'А до какого числа?', 'guest', key));
    expect(llm.calls - before).toBe(2);

    // AI: Третье сообщение за час - без модели, но с ответом (упрощённый режим), не с ошибкой.
    const third = await collect(
      engine.handle(ticket, user, 'Какие документы нужны?', 'guest', key),
    );
    expect(llm.calls - before).toBe(2);
    expect(third.length).toBeGreaterThan(20);
    expect(third).not.toContain('Ответ модели');

    // AI: Новая гостевая сессия с той же cookie устройства продолжает тот же счётчик.
    const again = await guest('a2');
    await collect(engine.handle(again.ticket, again.user, 'Адрес приёмной?', 'guest', key));
    expect(llm.calls - before).toBe(2);

    // AI: Другое устройство - свой бюджет.
    const other = await guest('b');
    await collect(
      engine.handle(other.ticket, other.user, 'Адрес приёмной?', 'guest', {
        device: 'dev-b',
        ip: '10.0.0.2',
      }),
    );
    expect(llm.calls - before).toBe(3);
  });

  it('guestPerHour = 0 means guests never reach the model; full users always do', async () => {
    const budget = new LlmBudget(counters, {
      guestPerHour: 0,
      guestPerDay: 0,
      guestIpPerHour: 0,
      dailyTokenBudget: 0,
    });
    const engine = makeEngine(budget);
    const before = llm.calls;
    const g = await guest('c');
    const text = await collect(
      engine.handle(g.ticket, g.user, 'Адрес приёмной?', 'guest', { device: 'dev-c' }),
    );
    expect(llm.calls - before).toBe(0);
    expect(text.length).toBeGreaterThan(0);

    const user = await tickets.upsertUser('web', 'student-1', 'Студент');
    const ticket = await tickets.create('tpu', user.id);
    await collect(engine.handle(ticket, user, 'Не работает VPN из дома', 'full'));
    expect(llm.calls - before).toBe(1);
  });

  it('daily token ceiling: 80 % cuts guests, 100 % cuts everyone', async () => {
    const budget = new LlmBudget(counters, {
      guestPerHour: 100,
      guestPerDay: 100,
      guestIpPerHour: 100,
      dailyTokenBudget: 1000,
    });
    expect((await budget.snapshot()).stage).toBe('ok');
    await budget.noteTokens(850);
    expect((await budget.snapshot()).stage).toBe('guests_off');
    expect(await budget.allows('guest', { device: 'dev-z' })).toBe(false);
    expect(await budget.allows('full')).toBe(true);
    await budget.noteTokens(200);
    const snap = await budget.snapshot();
    expect(snap.stage).toBe('all_off');
    expect(snap.usedShare).toBeGreaterThanOrEqual(1);
    expect(await budget.allows('full')).toBe(false);
  });
});

describe('guest chats are ephemeral', () => {
  it('purges guest tickets, messages and orphan guest users after the TTL', async () => {
    const g = await guest('purge-me');
    await tickets.addMessage(g.ticket.id, 'user', 'привет', {});
    const student = await tickets.upsertUser('web', 'student-keep', 'Студент');
    const st = await tickets.create('tpu', student.id);

    // AI: Свежий гостевой чат живёт; с TTL = 0 всё гостевое удаляется, чужое - нет.
    expect((await tickets.purgeGuests(60_000)).tickets).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    const r = await tickets.purgeGuests(0);
    expect(r.tickets).toBeGreaterThanOrEqual(1);
    expect(await tickets.getAny(g.ticket.id)).toBeUndefined();
    expect(await tickets.listMessages(g.ticket.id, 10)).toEqual([]);
    expect(await tickets.getUser(g.user.id)).toBeUndefined();
    expect(await tickets.getAny(st.id)).toBeDefined();
    expect(await tickets.getUser(student.id)).toBeDefined();
  });

  it('operator queue and stats do not see guest tickets', async () => {
    const g = await guest('invisible');
    await tickets.update(g.ticket.id, {
      state: 'closed',
      resolved: true,
      closedBy: 'ai',
      closedAt: new Date(),
      summary: 'гостевой',
    });
    const list = await tickets.listForOperator('tpu', 'op');
    expect(list.some((x) => x.ticket.id === g.ticket.id)).toBe(false);
    const before = (await tickets.operatorStats('tpu')).today.created;
    const s = await tickets.upsertUser('web', 'student-stats', 'Студент');
    await tickets.create('tpu', s.id);
    expect((await tickets.operatorStats('tpu')).today.created).toBe(before + 1);
  });
});
