import type {
  Analysis,
  ChatMessage,
  ChatStreamEvent,
  QuickReply,
  Scope,
  TicketCard,
  Tone,
} from '@helpdesk/shared';
import { TOPICS } from '@helpdesk/shared';
import type { TicketRow, UserRow } from '../../db/schema.js';
import { eventBase, type EventBus } from '../events/index.js';
import type { KnowledgeService, LoadedCatalog } from '../knowledge/index.js';
import { LlmUnavailableError, type LlmService } from '../llm/index.js';
import type { Passage, RagService } from '../rag/index.js';
import { extractFields, isRequired, optionMentioned, validateFields } from './extract.js';
import { inspectMessage, strongerTone } from '../safety/index.js';
import { toCard, type TicketRepository } from '../tickets/repository.js';
import type { HelpdeskConnector } from '../helpdesk/index.js';
import {
  CMD,
  QR_AFTER_SOLUTION,
  QR_CLOSED,
  QR_CLOSED_OR_NEW,
  QR_CONFIRM_CLOSE,
  QR_ESCALATED,
  QR_HELPED_ONLY,
  QR_NEW_ONLY,
  QR_OFFER_ESCALATION,
  T,
  type EscalationReason,
} from './templates.js';

/** AI: Пользователь плюс то, что знает только маршрут: оператор не ограничен дневными лимитами. */
export type Actor = UserRow & { operator?: boolean };

export interface EngineConfig {
  maxClarifications: number;
  /** AI: Дневные лимиты: заявки специалисту и просьбы позвать человека; 0 = без ограничений. */
  dailyRequestLimit: number;
  dailyHumanLimit: number;
  confidenceThreshold: number;
  historyTurns: number;
}

export interface EngineDeps {
  knowledge: KnowledgeService;
  /**
   * AI: Поиск по документации для вопросов, которых нет в проверенном каталоге; null = выключен.
   */
  rag: RagService | null;
  llm: LlmService;
  tickets: TicketRepository;
  events: EventBus;
  helpdesk: HelpdeskConnector;
  config: EngineConfig;
  log: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void };
}

/**
 * AI: Диалоговый движок - детерминированный конечный автомат. Модель вызывается ровно для двух
 * вещей - понять сообщение (структурированно) и сформулировать решение по найденной статье, - а
 * каждое решение (спросить / решить / передать / закрыть) принимается здесь, в коде. Поэтому
 * поведение тестируемо, дёшево и его нельзя «уговорить» выйти из роли.
 *
 * Состояния: intake -> clarifying* -> solving -> closed | escalated  (choosing_category при низкой
 * уверенности)
 */
export class DialogEngine {
  constructor(private readonly d: EngineDeps) {}

  async *handle(
    ticket: TicketRow,
    user: Actor,
    rawText: string,
    scope: Scope = 'full',
  ): AsyncGenerator<ChatStreamEvent> {
    const catalog = await this.d.knowledge.catalog(ticket.tenantId, scope);
    const text = rawText.trim();
    const isCmd = text.startsWith('__');

    await this.d.tickets.addMessage(
      ticket.id,
      'user',
      isCmd ? labelFor(text, catalog) : text,
      isCmd ? { command: text } : {},
    );

    // AI: Следующая проблема из того же сообщения: новое обращение, старое остаётся как есть.
    if (text === CMD.next && ticket.pendingProblems.length) {
      yield* this.nextProblem(ticket, user, catalog);
      return;
    }
    // AI: Пользователь может отозвать обращение из любого состояния - в том числе пока оно у
    // специалиста.
    if (text === CMD.close) {
      if (ticket.state === 'closed') {
        yield* this.reply(ticket, catalog, T.closedHint(), QR_CLOSED);
        return;
      }
      yield* this.withdraw(ticket, user, catalog);
      return;
    }
    if (text === CMD.keep && ticket.state === 'escalated') {
      yield* this.reply(ticket, catalog, T.keptOpen(), QR_ESCALATED);
      return;
    }

    // AI: Диалогом владеет специалист: помощник не должен говорить поверх него. Сообщение
    // сохраняется и уходит в консоль оператора; клиент получает тихое подтверждение.
    if (ticket.state === 'escalated') {
      if (isCmd) {
        yield* this.reply(ticket, catalog, T.withOperator(), QR_ESCALATED);
        return;
      }
      const touched = await this.d.tickets.update(ticket.id, { updatedAt: new Date() });
      await this.d.events.publish(TOPICS.ticketEvents, ticket.id, {
        ...eventBase(ticket.id, user.id),
        type: 'ticket.updated',
        tenantId: ticket.tenantId,
      });
      // AI: «Уже не актуально», пока обращение у специалиста: предлагаем закрыть, никогда не
      // закрываем по догадке.
      if (looksLikeWithdrawal(text)) {
        yield { type: 'meta', ticket: toCard(touched, catalog) };
        yield* this.reply(touched, catalog, T.confirmClose(), QR_CONFIRM_CLOSE);
        return;
      }
      yield { type: 'ack', ticket: toCard(touched, catalog) };
      return;
    }
    // AI: Закрытые тикеты не продолжаются - клиент предлагает «новый чат».
    if (ticket.state === 'closed') {
      yield* this.reply(ticket, catalog, T.closedHint(), QR_CLOSED);
      return;
    }

    yield { type: 'meta', ticket: toCard(ticket, catalog) };

    // ---------- команды движка (кнопки) ----------
    if (text.startsWith(CMD.category)) {
      const categoryId = text.slice(CMD.category.length);
      if (!catalog.categoryById.has(categoryId)) {
        yield* this.reply(
          ticket,
          catalog,
          T.chooseCategory(),
          T.categoryButtons(catalog.categories),
        );
        return;
      }
      ticket = await this.setCategory(ticket, user, catalog, categoryId, 1);
      yield* this.advance(ticket, user, catalog, ticket.summary ?? '');
      return;
    }
    if (text === CMD.helped && ticket.state === 'solving') {
      yield* this.resolve(ticket, user, catalog);
      return;
    }
    if (text === CMD.notHelped && ticket.state === 'solving') {
      yield* this.nextSolution(ticket, user, catalog);
      return;
    }
    if (text === CMD.human) {
      yield* this.humanRequested(ticket, user, catalog, ticket.summary ?? '');
      return;
    }
    if (text === CMD.escalate) {
      // AI: Согласие на предложение помощника («Создать заявку?») - решение уже пробовали.
      if (catalog.scope === 'guest') {
        yield* this.reply(ticket, catalog, T.guestNoEscalation('user_request'));
        return;
      }
      yield* this.escalate(
        ticket,
        user,
        catalog,
        (ticket.pendingEscalation as EscalationReason | null) ?? 'user_request',
      );
      return;
    }
    if (text.startsWith(CMD.pick)) {
      const n = Number(text.slice(CMD.pick.length));
      const chosen = ticket.pendingProblems[n];
      if (chosen === undefined) {
        yield* this.reply(
          ticket,
          catalog,
          T.chooseCategory(),
          T.problemButtons(ticket.pendingProblems),
        );
        return;
      }
      ticket = await this.d.tickets.update(ticket.id, {
        summary: chosen,
        pendingProblems: ticket.pendingProblems.filter((_, i) => i !== n),
      });
      yield { type: 'meta', ticket: toCard(ticket, catalog) };
      yield* this.freeText(ticket, user, catalog, chosen);
      return;
    }
    if (text === CMD.dismiss) {
      const back = ticket.articleId ? 'solving' : 'intake';
      ticket = await this.d.tickets.update(ticket.id, { state: back, pendingEscalation: null });
      yield { type: 'meta', ticket: toCard(ticket, catalog) };
      yield* this.reply(
        ticket,
        catalog,
        T.dismissed(back === 'solving'),
        back === 'solving' ? QR_AFTER_SOLUTION : QR_CLOSED_OR_NEW,
      );
      return;
    }
    if (isCmd) {
      // AI: Неизвестная / устаревшая команда - вежливо игнорируем.
      yield* this.reply(
        ticket,
        catalog,
        T.afterSolution(),
        ticket.state === 'solving' ? QR_AFTER_SOLUTION : undefined,
      );
      return;
    }

    // ---------- ответ кнопкой на уточняющий вопрос: модель не нужна ----------
    if (ticket.state === 'clarifying' && ticket.pendingField && ticket.categoryId) {
      const field = catalog.categoryById
        .get(ticket.categoryId)
        ?.clarify.find((f) => f.id === ticket.pendingField);
      const option = field?.options?.find((o) => o.toLowerCase() === text.toLowerCase());
      if (option) {
        ticket = await this.d.tickets.update(ticket.id, {
          fields: { ...ticket.fields, [field!.id]: option },
          pendingField: null,
        });
        yield* this.advance(ticket, user, catalog, text);
        return;
      }
    }

    if (ticket.state === 'offer_escalation' && !isCmd) {
      // AI: Пользователь продолжил писать вместо выбора: считаем это новой информацией о проблеме.
      ticket = await this.d.tickets.update(ticket.id, {
        state: ticket.articleId ? 'solving' : 'intake',
        pendingEscalation: null,
      });
    }

    yield* this.freeText(ticket, user, catalog, text);
  }

  /** AI: Свободный текст: понять (модель или запасной разбор), затем выбрать переход. */
  private async *freeText(
    ticket: TicketRow,
    user: UserRow,
    catalog: LoadedCatalog,
    text: string,
  ): AsyncGenerator<ChatStreamEvent> {
    // AI: Приветствия / «ты тут?» / спасибо не требуют модели - отвечаем мгновенно и тепло.
    if (isSmalltalk(text)) {
      const solving = ticket.state === 'solving';
      yield* this.reply(
        ticket,
        catalog,
        T.smalltalk(text, solving),
        solving ? QR_AFTER_SOLUTION : undefined,
      );
      return;
    }
    const safety = inspectMessage(text);
    if (safety.injectionAttempt)
      this.d.log.warn({ ticketId: ticket.id }, 'prompt injection markers in user message');

    yield {
      type: 'status',
      text: ticket.categoryId ? 'Анализирую ответ…' : 'Определяю суть обращения…',
    };
    const history = await this.history(ticket.id);
    let analysis: Analysis;
    let llmDown = false;
    try {
      analysis = await this.d.llm.analyze(catalog, {
        history,
        message: text,
        knownFields: ticket.fields,
        fixedCategoryId: ticket.categoryId ?? undefined,
      });
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) throw err;
      llmDown = true;
      analysis = await this.fallbackAnalyze(catalog, ticket, text);
    }

    const tone = strongerTone(safety.toneHint, analysis.tone);
    // AI: Значения, извлечённые моделью, проходят белые списки каталога (несуществующее общежитие
    // или корпус отбрасывается здесь; пользователю об этом скажет advance()).
    const knownCategory = catalog.categoryById.get(ticket.categoryId ?? analysis.categoryId);
    const fields = {
      ...ticket.fields,
      ...validateFields(knownCategory?.clarify ?? [], cleanFields(analysis.fields)).fields,
    };
    if (ticket.state === 'clarifying' && ticket.pendingField && !fields[ticket.pendingField]) {
      // AI: Пользователь ответил на наш вопрос свободным текстом - сохраняем ответ как есть.
      fields[ticket.pendingField] = text.slice(0, 200);
    }
    // AI: Суть обращения: никогда из болтовни; уточняется, пока проблема ещё понимается, и
    // замораживается после перехода к решению.
    const keepSummary =
      analysis.offTopic || analysis.asksToClose === true || ticket.state === 'solving';
    const summary = keepSummary
      ? ticket.summary
      : (soberSummary(analysis.summary) ?? ticket.summary);
    ticket = await this.d.tickets.update(ticket.id, {
      fields,
      tone,
      pendingField: null,
      priority: bumpPriority(ticket.priority, tone),
      summary,
    });
    this.d.log.info(
      {
        ticketId: ticket.id,
        state: ticket.state,
        category: analysis.categoryId,
        confidence: analysis.confidence,
        tone,
        offTopic: analysis.offTopic,
        asksForHuman: analysis.asksForHuman,
        llmDown,
      },
      'message analysed',
    );
    // AI: Карточка со свежей сутью уходит сразу, чтобы история на клиенте показала тикет, пока
    // ответ ещё пишется.
    yield { type: 'meta', ticket: toCard(ticket, catalog) };

    if (analysis.asksForHuman) {
      // AI: «Позовите человека» первым сообщением: категория, которую увидела модель, всё равно
      // попадает на карточку - от неё зависят нужные поля и очередь, куда уйдёт заявка.
      if (
        !ticket.categoryId &&
        catalog.categoryById.has(analysis.categoryId) &&
        analysis.confidence >= this.d.config.confidenceThreshold
      ) {
        ticket = await this.setCategory(
          ticket,
          user,
          catalog,
          analysis.categoryId,
          analysis.confidence,
        );
      }
      yield* this.humanRequested(ticket, user, catalog, text);
      return;
    }
    if (ticket.pendingEscalation === 'user_request' && ticket.state === 'intake') {
      // AI: Описание после «свяжи с оператором» пришло: сначала пробуем решить сами, как и обещали;
      // кнопка «Нужен специалист» появится вместе с решением.
      ticket = await this.d.tickets.update(ticket.id, { pendingEscalation: null });
    }
    if ((analysis.reportsResolved && ticket.state === 'solving') || analysis.asksToClose) {
      // AI: Явное «закрой» завершает обращение даже до показа решения.
      yield* this.resolve(
        ticket,
        user,
        catalog,
        analysis.asksToClose === true ? 'user_request' : 'helped',
      );
      return;
    }
    if (analysis.offTopic && ticket.state !== 'solving') {
      // AI: Приветствия отработаны до вызова модели (isSmalltalk). Сюда попадает вопрос или просьба
      // не по теме; ответ модели не должен содержать ответа на неё (викторина, стих, факт) - только
      // возврат к теме. Если похоже на ответ по существу - используем детерминированный шаблон.
      const model = analysis.smalltalkReply?.trim() ?? '';
      const redirectOnly = model.length > 0 && model.length <= 220 && !/[0-9:\n]/.test(model);
      yield* this.reply(ticket, catalog, redirectOnly ? model : T.offTopic());
      return;
    }

    // AI: Несколько проблем в одном сообщении: не смешиваем их в одну заявку - пользователь
    // выбирает первую, остальные ждут своей очереди (каждая станет отдельным обращением).
    const problems = (analysis.problems ?? [])
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (!ticket.categoryId && ticket.state === 'intake' && problems.length > 1) {
      ticket = await this.d.tickets.update(ticket.id, { pendingProblems: problems, summary: null });
      yield { type: 'meta', ticket: toCard(ticket, catalog) };
      this.d.log.info({ ticketId: ticket.id, problems: problems.length }, 'several problems');
      yield* this.reply(ticket, catalog, T.severalProblems(problems), T.problemButtons(problems));
      return;
    }

    if (!ticket.categoryId) {
      const known = catalog.categoryById.has(analysis.categoryId);
      if (known && analysis.confidence >= this.d.config.confidenceThreshold) {
        ticket = await this.setCategory(
          ticket,
          user,
          catalog,
          analysis.categoryId,
          analysis.confidence,
        );
      } else if (ticket.state === 'choosing_category') {
        // AI: Второй промах подряд: не зацикливаемся, предлагаем передачу с тем, что есть.
        yield* this.offerEscalation(ticket, catalog, 'low_confidence');
        return;
      } else {
        ticket = await this.d.tickets.update(ticket.id, {
          state: 'choosing_category',
          confidence: analysis.confidence,
          categoryId: null,
        });
        yield { type: 'meta', ticket: toCard(ticket, catalog) };
        yield* this.reply(
          ticket,
          catalog,
          T.chooseCategory(),
          T.categoryButtons(catalog.categories),
        );
        return;
      }
    }

    // AI: В состоянии «решение»: жалоба означает, что шаги не помогли; вопрос отвечается на месте
    // (другая статья или документация); всё остальное - деталь, которую отмечаем.
    if (ticket.state === 'solving') {
      if (NEGATIVE.test(text.toLowerCase())) {
        yield* this.nextSolution(ticket, user, catalog, text);
      } else if (isQuestion(text) || text.length > 80) {
        yield* this.followUp(ticket, catalog, text);
      } else {
        yield* this.reply(ticket, catalog, T.noted(), QR_AFTER_SOLUTION);
      }
      return;
    }

    yield* this.advance(ticket, user, catalog, text, llmDown);
  }

  // ---------- переходы ----------

  /** AI: Задать следующее обязательное уточнение или искать решение. */
  private async *advance(
    ticket: TicketRow,
    user: UserRow,
    catalog: LoadedCatalog,
    lastText: string,
    llmDown = false,
    lead?: string,
  ): AsyncGenerator<ChatStreamEvent> {
    const category = catalog.categoryById.get(ticket.categoryId!)!;

    // AI: Вытащить идентификаторы, которые пользователь уже назвал (номер общежития, комната), из
    // сообщения до того, как решать, что спрашивать, - и остановиться сразу, если значения не может
    // существовать (например, общежитие, которого никогда не было).
    const found = extractFields(category.clarify, lastText);
    if (Object.keys(found.fields).length) {
      ticket = await this.d.tickets.update(ticket.id, {
        fields: { ...ticket.fields, ...found.fields },
      });
    }
    if (found.reject) {
      ticket = await this.d.tickets.update(ticket.id, {
        state: 'clarifying',
        pendingField: found.reject.fieldId,
      });
      yield { type: 'meta', ticket: toCard(ticket, catalog) };
      yield* this.reply(ticket, catalog, found.reject.message);
      return;
    }

    // AI: Передача была приостановлена ради одного вопроса (см. escalate()); ответ получен -
    // продолжаем её.
    if (ticket.pendingEscalation && ticket.state === 'clarifying') {
      yield* this.escalate(ticket, user, catalog, ticket.pendingEscalation as EscalationReason);
      return;
    }

    const missing = category.clarify.filter(
      (f) => isRequired(f, ticket.fields) && !ticket.fields[f.id],
    );
    if (missing.length && ticket.clarificationsAsked < this.d.config.maxClarifications) {
      const field = missing[0]!;
      ticket = await this.d.tickets.update(ticket.id, {
        state: 'clarifying',
        pendingField: field.id,
        clarificationsAsked: ticket.clarificationsAsked + 1,
      });
      yield { type: 'meta', ticket: toCard(ticket, catalog) };
      this.d.log.info({ ticketId: ticket.id, field: field.id }, 'clarification asked');
      yield* this.reply(
        ticket,
        catalog,
        (lead ? lead + '\n\n' : '') + T.clarify(field.question),
        T.clarifyButtons(field.options),
      );
      return;
    }
    yield* this.solve(ticket, user, catalog, lastText, llmDown, lead);
  }

  private async *solve(
    ticket: TicketRow,
    user: UserRow,
    catalog: LoadedCatalog,
    lastText: string,
    llmDown = false,
    lead?: string,
  ): AsyncGenerator<ChatStreamEvent> {
    const category = catalog.categoryById.get(ticket.categoryId!)!;
    const query = [ticket.summary ?? '', lastText, ...Object.values(ticket.fields)].join(' ');
    const [best] = await this.d.knowledge.search(ticket.tenantId, query, {
      categoryId: category.id,
      limit: 1,
      exclude: new Set(ticket.triedArticles),
    });
    if (!best || best.score < MIN_SOLUTION_SCORE) {
      // AI: Проверенной статьи нет - пробуем корпус документации, прежде чем сдаться.
      if (
        !llmDown &&
        !ticket.triedArticles.length &&
        (yield* this.ragAnswer(ticket, user, catalog, lastText))
      )
        return;
      yield* this.offerEscalation(
        ticket,
        catalog,
        ticket.triedArticles.length ? 'solution_failed' : 'no_solution',
      );
      return;
    }
    const article = best.article;
    // AI: Фрагменты документации обогащают статью фактами (адреса, телефоны, сроки).
    const passages = await this.retrieve(ticket, catalog, query, 3);
    ticket = await this.d.tickets.update(ticket.id, {
      state: 'solving',
      articleId: article.id,
      pendingField: null,
    });
    yield { type: 'meta', ticket: toCard(ticket, catalog) };
    this.d.log.info(
      { ticketId: ticket.id, articleId: article.id, score: Math.round(best.score * 10) / 10 },
      'solution: article',
    );
    yield { type: 'status', text: `Подбираю решение: «${article.title}»…` };
    await this.d.events.publish(TOPICS.ticketEvents, ticket.id, {
      ...eventBase(ticket.id, user.id),
      type: 'ticket.solution_shown',
      articleId: article.id,
    });

    let text = '';
    if (lead) {
      text += lead + '\n\n';
      yield { type: 'delta', text: lead + '\n\n' };
    }
    if (llmDown) {
      const note = T.llmDown() + '\n\n';
      text += note;
      yield { type: 'delta', text: note };
    }

    let streamed = '';
    let failed = llmDown;
    let noSolution = false;
    if (!failed) {
      const r = yield* this.streamGrounded(
        this.d.llm.solve(catalog, {
          summary: ticket.summary ?? lastText,
          category,
          fields: ticket.fields,
          article,
          tone: ticket.tone as Tone,
          lastMessage: lastText,
          passages,
        }),
      );
      streamed = r.text;
      failed = r.failed;
      noSolution = r.noSolution;
    }
    if (noSolution) {
      this.d.log.info(
        { ticketId: ticket.id, articleId: article.id },
        'solution: article rejected by model',
      );
      // AI: Модель сочла лучшую статью нерелевантной: не показываем и больше не достаём. Пробуем
      // документацию, затем честно предлагаем передачу.
      const firstTry = !ticket.triedArticles.length;
      ticket = await this.d.tickets.update(ticket.id, {
        articleId: null,
        state: 'intake',
        triedArticles: [...new Set([...ticket.triedArticles, article.id])],
      });
      if (firstTry && (yield* this.ragAnswer(ticket, user, catalog, lastText))) return;
      yield* this.offerEscalation(ticket, catalog, firstTry ? 'no_solution' : 'solution_failed');
      return;
    }
    if (failed || !streamed.trim()) {
      // AI: Детерминированный запасной вариант: шаги статьи дословно. Чат не умирает вместе с
      // моделью.
      const fb = (streamed.trim() ? '\n\n' : '') + T.solutionFallback(article);
      streamed += fb;
      yield { type: 'delta', text: fb };
    }
    text += streamed.trim();

    if (article.escalateAfter) {
      // AI: Статья сама говорит, что дальше работает специалист: отдаём шаги, затем спрашиваем,
      // создавать ли заявку (два события `done`; клиент добавляет оба).
      yield* this.finish(ticket, catalog, text, undefined, { articleId: article.id });
      yield* this.offerEscalation(ticket, catalog, 'article_requires_specialist');
      return;
    }
    const tail = '\n\n' + T.afterSolution();
    yield { type: 'delta', text: tail };
    yield* this.finish(ticket, catalog, text + tail, QR_AFTER_SOLUTION, { articleId: article.id });
  }

  /** AI: Гибридный поиск по скачанной документации в пределах того, что видна этой сессии. */
  private async retrieve(
    ticket: TicketRow,
    catalog: LoadedCatalog,
    query: string,
    limit: number,
  ): Promise<Passage[]> {
    if (!this.d.rag) return [];
    try {
      return await this.d.rag.search(ticket.tenantId, query, { scope: catalog.scope, limit });
    } catch (err) {
      this.d.log.warn({ err, ticketId: ticket.id }, 'rag retrieval failed');
      return [];
    }
  }

  /**
   * AI: Путь RAG: ответ по фрагментам документации, когда статья каталога не подошла. Возвращает
   * true, если ответ выдан; false (ничего релевантного / модель сказала [NO_SOLUTION] / модель
   * недоступна) даёт вызывающему коду перейти к предложению передачи. Ничего не показывается, если
   * не подтверждено источником.
   */
  private async *ragAnswer(
    ticket: TicketRow,
    user: UserRow,
    catalog: LoadedCatalog,
    lastText: string,
  ): AsyncGenerator<ChatStreamEvent, boolean> {
    if (!this.d.rag || !this.d.llm.enabled) return false;
    const query = [ticket.summary ?? '', lastText, ...Object.values(ticket.fields)].join(' ');
    const passages = await this.retrieve(ticket, catalog, query, 5);
    if (!passages.length) return false;

    yield { type: 'status', text: 'Ищу ответ в документации…' };
    this.d.log.info(
      { ticketId: ticket.id, passages: passages.map((p) => p.url) },
      'solution: documentation',
    );
    const r = yield* this.streamGrounded(
      this.d.llm.answer(catalog, {
        summary: ticket.summary ?? lastText,
        categoryName: ticket.categoryId
          ? catalog.categoryById.get(ticket.categoryId)?.name
          : undefined,
        fields: ticket.fields,
        tone: ticket.tone as Tone,
        lastMessage: lastText,
        passages,
      }),
    );
    if (r.noSolution || !r.text.trim()) return false;
    const streamed = r.text;

    ticket = await this.d.tickets.update(ticket.id, {
      state: 'solving',
      articleId: null,
      pendingField: null,
    });
    yield { type: 'meta', ticket: toCard(ticket, catalog) };
    await this.d.events.publish(TOPICS.ticketEvents, ticket.id, {
      ...eventBase(ticket.id, user.id),
      type: 'ticket.solution_shown',
      articleId: 'rag',
    });
    const tail = '\n\n' + T.afterSolution();
    yield { type: 'delta', text: tail };
    yield* this.finish(ticket, catalog, streamed.trim() + tail, QR_AFTER_SOLUTION, {
      rag: passages.slice(0, 3).map((p) => ({ url: p.url, title: p.title })),
    });
    return true;
  }

  /**
   * AI: Стримит вывод модели клиенту, придерживая первые символы, пока не станет ясно, что ответ не
   * начинается с [NO_SOLUTION]. Возвращает показанное; `failed` означает, что модель отвалилась
   * посередине (как откатываться, решает вызывающий код).
   */
  private async *streamGrounded(
    gen: AsyncGenerator<string, void, void>,
  ): AsyncGenerator<ChatStreamEvent, { text: string; noSolution: boolean; failed: boolean }> {
    let text = '';
    let head = '';
    let decided = false;
    try {
      for await (const chunk of gen) {
        if (!decided) {
          head += chunk;
          if (head.trimStart().startsWith(NO_SOLUTION))
            return { text: '', noSolution: true, failed: false };
          if (head.length >= NO_SOLUTION.length + 2 || head.includes('\n')) {
            decided = true;
            text = head;
            yield { type: 'delta', text: head };
          }
          continue;
        }
        text += chunk;
        yield { type: 'delta', text: chunk };
      }
      if (!decided) {
        if (head.trimStart().startsWith(NO_SOLUTION))
          return { text: '', noSolution: true, failed: false };
        text = head;
        if (head) yield { type: 'delta', text: head };
      }
      return { text, noSolution: false, failed: false };
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) throw err;
      return { text, noSolution: false, failed: true };
    }
  }

  /**
   * AI: Вопрос, заданный, пока на экране решение («а где находится деканат?»), отвечается по лучшей
   * статье из всего каталога или по документации; текущее решение и его кнопки остаются на месте.
   */
  private async *followUp(
    ticket: TicketRow,
    catalog: LoadedCatalog,
    text: string,
  ): AsyncGenerator<ChatStreamEvent> {
    const [best] = await this.d.knowledge.search(ticket.tenantId, text, { limit: 1 });
    const category = best && catalog.categoryById.get(best.article.categoryId);
    if (
      best &&
      category &&
      best.score >= MIN_SOLUTION_SCORE &&
      best.article.id !== ticket.articleId
    ) {
      if (!this.d.llm.enabled) {
        yield* this.reply(ticket, catalog, T.solutionFallback(best.article), QR_AFTER_SOLUTION);
        return;
      }
      const r = yield* this.streamGrounded(
        this.d.llm.solve(catalog, {
          summary: text,
          category,
          fields: ticket.fields,
          article: best.article,
          tone: ticket.tone as Tone,
          lastMessage: text,
          passages: await this.retrieve(ticket, catalog, text, 3),
        }),
      );
      if (r.text.trim()) {
        yield* this.finish(ticket, catalog, r.text.trim(), QR_AFTER_SOLUTION, {
          articleId: best.article.id,
        });
        return;
      }
      if (r.failed) {
        yield* this.reply(ticket, catalog, T.solutionFallback(best.article), QR_AFTER_SOLUTION);
        return;
      }
    }
    const passages = await this.retrieve(ticket, catalog, text, 5);
    if (passages.length && this.d.llm.enabled) {
      const r = yield* this.streamGrounded(
        this.d.llm.answer(catalog, {
          summary: text,
          fields: ticket.fields,
          tone: ticket.tone as Tone,
          lastMessage: text,
          passages,
        }),
      );
      if (r.text.trim()) {
        yield* this.finish(ticket, catalog, r.text.trim(), QR_AFTER_SOLUTION, {
          rag: passages.slice(0, 3).map((p) => ({ url: p.url, title: p.title })),
        });
        return;
      }
    }
    yield* this.reply(ticket, catalog, T.noAnswer(), QR_AFTER_SOLUTION);
  }

  private async *nextSolution(
    ticket: TicketRow,
    user: UserRow,
    catalog: LoadedCatalog,
    lastText = '',
  ): AsyncGenerator<ChatStreamEvent> {
    const tried = ticket.articleId
      ? [...new Set([...ticket.triedArticles, ticket.articleId])]
      : ticket.triedArticles;
    ticket = await this.d.tickets.update(ticket.id, { triedArticles: tried });
    const query = [ticket.summary ?? '', lastText, ...Object.values(ticket.fields)].join(' ');
    const ranked = await this.d.knowledge.search(ticket.tenantId, query, {
      categoryId: ticket.categoryId!,
      limit: 5,
    });
    const top = ranked[0]?.score ?? 0;
    const next = ranked.find((r) => !tried.includes(r.article.id));
    // AI: Вторую статью предлагаем только если она сопоставима с лучшей; иначе перестаём гадать.
    if (!next || next.score < 0.6 * top || tried.length >= 2) {
      yield* this.offerEscalation(ticket, catalog, 'solution_failed');
      return;
    }
    yield* this.solve(ticket, user, catalog, lastText, false, T.nextArticle(next.article));
  }

  private async *resolve(
    ticket: TicketRow,
    user: UserRow,
    catalog: LoadedCatalog,
    reason: 'helped' | 'user_request' = 'helped',
  ): AsyncGenerator<ChatStreamEvent> {
    ticket = await this.d.tickets.update(ticket.id, {
      state: 'closed',
      resolved: true,
      closedBy: 'assistant',
      closedAt: new Date(),
    });
    const card = toCard(ticket, catalog);
    this.d.log.info(
      { ticketId: ticket.id, reason, articleId: ticket.articleId },
      'ticket resolved',
    );
    await this.d.events.publish(TOPICS.ticketEvents, ticket.id, {
      ...eventBase(ticket.id, user.id),
      type: 'ticket.resolved',
      ticket: card,
    });
    yield { type: 'meta', ticket: card };
    yield* this.reply(ticket, catalog, T.resolved(card, reason) + this.remainingTail(ticket), [
      ...QR_CLOSED,
      ...this.remainingButtons(ticket),
    ]);
  }

  private remainingTail(ticket: TicketRow): string {
    const [next] = ticket.pendingProblems;
    return next ? T.remainingProblem(next, ticket.pendingProblems.length) : '';
  }

  private remainingButtons(ticket: TicketRow): QuickReply[] {
    const [next] = ticket.pendingProblems;
    return next ? [T.nextButton(next)] : [];
  }

  /**
   * AI: Переход к следующей проблеме из того же сообщения: новое обращение с этой сутью,
   * очередь остальных переезжает в него, текущее остаётся закрытым / у специалиста.
   */
  private async *nextProblem(
    ticket: TicketRow,
    user: UserRow,
    catalog: LoadedCatalog,
  ): AsyncGenerator<ChatStreamEvent> {
    const [next, ...rest] = ticket.pendingProblems;
    await this.d.tickets.update(ticket.id, { pendingProblems: [] });
    let fresh = await this.d.tickets.create(ticket.tenantId, user.id);
    fresh = await this.d.tickets.update(fresh.id, { summary: next, pendingProblems: rest });
    await this.d.tickets.addMessage(fresh.id, 'user', next!, {});
    await this.d.events.publish(TOPICS.ticketEvents, fresh.id, {
      ...eventBase(fresh.id, user.id),
      type: 'ticket.created',
      ticket: toCard(fresh, catalog),
    });
    yield { type: 'meta', ticket: toCard(fresh, catalog) };
    yield* this.freeText(fresh, user, catalog, next!);
  }

  /**
   * AI: Помощник никогда не создаёт заявку сам: объясняет, почему не может продолжить, и
   * спрашивает. Только явное «да» (или просьба позвать человека) создаёт внешнюю заявку.
   */
  private async *offerEscalation(
    ticket: TicketRow,
    catalog: LoadedCatalog,
    reason: EscalationReason,
  ): AsyncGenerator<ChatStreamEvent> {
    if (catalog.scope === 'guest') {
      // AI: Гостям ни заявки, ни оператора - объясняем, как их получить, и оставляем диалог
      // открытым.
      yield* this.reply(
        ticket,
        catalog,
        T.guestNoEscalation(reason),
        ticket.articleId ? QR_HELPED_ONLY : undefined,
      );
      return;
    }
    if (ticket.escalationBlocked) {
      // AI: Специалист решил, что этот тикет остаётся у помощника; больше не предлагаем передачу.
      yield* this.reply(
        ticket,
        catalog,
        T.escalationBlocked(),
        ticket.articleId ? QR_HELPED_ONLY : QR_NEW_ONLY,
      );
      return;
    }
    ticket = await this.d.tickets.update(ticket.id, {
      state: 'offer_escalation',
      pendingEscalation: reason,
    });
    this.d.log.info({ ticketId: ticket.id, reason }, 'escalation offered');
    yield { type: 'meta', ticket: toCard(ticket, catalog) };
    yield* this.reply(ticket, catalog, T.offerEscalation(reason), QR_OFFER_ESCALATION);
  }

  /**
   * AI: Заявка специалисту - только когда помощник уже пробовал: решение показано (или его
   * не нашлось, и помощник сам предложил передачу). До этого просьба «позовите человека» -
   * повод попробовать, а не передать.
   */
  private canEscalateNow(ticket: TicketRow): boolean {
    return (
      ticket.state === 'solving' ||
      ticket.state === 'offer_escalation' ||
      ticket.articleId !== null ||
      ticket.triedArticles.length > 0
    );
  }

  /**
   * AI: Пользователь просит человека (кнопка или текст). Порядок: гость - нельзя; оператор
   * уже вернул - нельзя; дневной лимит просьб; сначала попытка решить; и только затем заявка.
   */
  private async *humanRequested(
    ticket: TicketRow,
    user: Actor,
    catalog: LoadedCatalog,
    text: string,
  ): AsyncGenerator<ChatStreamEvent> {
    if (catalog.scope === 'guest') {
      yield* this.reply(
        ticket,
        catalog,
        T.guestNoEscalation('user_request'),
        ticket.articleId ? QR_HELPED_ONLY : undefined,
      );
      return;
    }
    if (ticket.escalationBlocked) {
      // AI: Оператор уже смотрел этот тикет и вернул его - не ставим в очередь снова.
      yield* this.reply(
        ticket,
        catalog,
        T.escalationBlocked(),
        ticket.articleId ? QR_HELPED_ONLY : QR_NEW_ONLY,
      );
      return;
    }
    const limit = this.d.config.dailyHumanLimit;
    if (!user.operator && limit > 0) {
      const c = await this.d.tickets.countersToday(user.id);
      if (c.humanCalls >= limit) {
        this.d.log.info({ ticketId: ticket.id, userId: user.id }, 'daily human-call limit reached');
        yield* this.reply(
          ticket,
          catalog,
          T.tooManyHumanCalls(limit),
          ticket.state === 'solving' ? QR_HELPED_ONLY : undefined,
        );
        return;
      }
      await this.d.tickets.bumpCounter(user.id, 'humanCalls');
    }
    if (!this.canEscalateNow(ticket)) {
      if (!ticket.categoryId) {
        // AI: О проблеме ещё ни слова (или категория не понята): просим описать, что случилось.
        ticket = await this.d.tickets.update(ticket.id, { pendingEscalation: 'user_request' });
        yield { type: 'meta', ticket: toCard(ticket, catalog) };
        yield* this.reply(ticket, catalog, T.describeBeforeHuman());
        return;
      }
      // AI: Категория есть, решения ещё не было: обещаем специалиста, если не поможет, и решаем.
      yield* this.advance(ticket, user, catalog, text, false, T.tryFirst());
      return;
    }
    yield* this.escalate(ticket, user, catalog, 'user_request', text);
  }

  private async *escalate(
    ticket: TicketRow,
    user: Actor,
    catalog: LoadedCatalog,
    reason: EscalationReason,
    lastText = '',
  ): AsyncGenerator<ChatStreamEvent> {
    if (catalog.scope === 'guest') {
      yield* this.reply(ticket, catalog, T.guestNoEscalation(reason));
      return;
    }
    const limit = this.d.config.dailyRequestLimit;
    if (!user.operator && limit > 0) {
      const c = await this.d.tickets.countersToday(user.id);
      if (c.requests >= limit) {
        this.d.log.info({ ticketId: ticket.id, userId: user.id }, 'daily request limit reached');
        const back = ticket.articleId ? 'solving' : 'intake';
        ticket = await this.d.tickets.update(ticket.id, { state: back, pendingEscalation: null });
        yield { type: 'meta', ticket: toCard(ticket, catalog) };
        yield* this.reply(
          ticket,
          catalog,
          T.tooManyRequests(limit),
          back === 'solving' ? QR_HELPED_ONLY : undefined,
        );
        return;
      }
    }
    // AI: Специалист не должен начинать с вопросов, которые мог задать помощник: сначала собираем
    // обязательные поля категории (по одному вопросу, в пределах обычного лимита). Пользователь не
    // застревает - после лимита заявка уходит как есть.
    const category = ticket.categoryId ? catalog.categoryById.get(ticket.categoryId) : undefined;
    const found = category ? extractFields(category.clarify, lastText) : { fields: {} };
    if (Object.keys(found.fields).length)
      ticket = await this.d.tickets.update(ticket.id, {
        fields: { ...ticket.fields, ...found.fields },
      });
    if (found.reject) {
      // AI: «Позовите человека, корпус 40» - такого места нет; заявка на него не уходит.
      ticket = await this.d.tickets.update(ticket.id, {
        state: 'clarifying',
        pendingField: found.reject.fieldId,
        pendingEscalation: reason,
      });
      yield { type: 'meta', ticket: toCard(ticket, catalog) };
      yield* this.reply(ticket, catalog, found.reject.message);
      return;
    }
    const missing = (category?.clarify ?? []).filter(
      (f) => isRequired(f, ticket.fields) && !ticket.fields[f.id],
    );
    if (missing.length && ticket.clarificationsAsked < this.d.config.maxClarifications) {
      const field = missing[0]!;
      ticket = await this.d.tickets.update(ticket.id, {
        state: 'clarifying',
        pendingField: field.id,
        pendingEscalation: reason,
        clarificationsAsked: ticket.clarificationsAsked + 1,
      });
      yield { type: 'meta', ticket: toCard(ticket, catalog) };
      this.d.log.info(
        { ticketId: ticket.id, field: field.id, reason },
        'clarification asked before escalation',
      );
      yield* this.reply(
        ticket,
        catalog,
        T.clarifyBeforeEscalation(field.question),
        T.clarifyButtons(field.options),
      );
      return;
    }
    yield { type: 'status', text: 'Создаю заявку…' };
    // AI: Сначала создаём заявку во внешнем helpdesk, чтобы на карточке был настоящий номер.
    let external: { externalId: string; url?: string } | null = null;
    try {
      const transcript = (await this.d.tickets.listMessages(ticket.id, 60))
        .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Помощник'}: ${m.content}`)
        .join('\n');
      external = await this.d.helpdesk.createRequest(toCard(ticket, catalog), {
        userDisplayName: user.displayName,
        transcript,
      });
    } catch (err) {
      // AI: Чат не должен падать из-за недоступного helpdesk: оставляем внутренний id, повтор позже
      // через события.
      this.d.log.warn(
        { ticketId: ticket.id, err: (err as Error).message },
        'helpdesk request creation failed',
      );
    }
    ticket = await this.d.tickets.update(ticket.id, {
      state: 'escalated',
      escalated: true,
      handledBy: 'operator',
      escalationReason: reason,
      pendingEscalation: null,
      externalId: external?.externalId ?? null,
      externalUrl: external?.url ?? null,
      closedAt: new Date(),
      priority:
        reason === 'user_request' ? bumpPriority(ticket.priority, 'frustrated') : ticket.priority,
    });
    const card = toCard(ticket, catalog);
    if (!user.operator) await this.d.tickets.bumpCounter(user.id, 'requests');
    this.d.log.info(
      {
        ticketId: ticket.id,
        reason,
        externalId: ticket.externalId,
        helpdesk: this.d.helpdesk.kind,
      },
      'ticket escalated',
    );
    await this.d.events.publish(TOPICS.ticketEvents, ticket.id, {
      ...eventBase(ticket.id, user.id),
      type: 'ticket.escalated',
      reason,
      ticket: card,
    });
    await this.d.events.publish(TOPICS.notifications, ticket.id, {
      eventId: eventBase(ticket.id, user.id).eventId,
      occurredAt: new Date().toISOString(),
      ticketId: ticket.id,
      platform: user.platform as 'telegram' | 'vk' | 'max' | 'web',
      platformUserId: user.platformUserId,
      text: `Заявка №${card.externalId ?? ticket.id.slice(0, 8).toUpperCase()} создана и передана специалисту. Ответ придёт в этот чат.`,
    });
    yield { type: 'meta', ticket: card };
    yield* this.reply(
      ticket,
      catalog,
      T.escalated(
        card,
        reason,
        missing.map((f) => f.label ?? f.id),
      ) + this.remainingTail(ticket),
      [...QR_ESCALATED, ...this.remainingButtons(ticket)],
    );
  }

  /**
   * AI: Пользователь отзывает обращение: из чата (кнопка / «уже не актуально») или из карточки.
   * Отозванный тикет закрыт, но не «решён» - статистика остаётся честной. Если он был у
   * специалиста, консоль и внешний helpdesk уведомляются.
   */
  private async *withdraw(
    ticket: TicketRow,
    user: UserRow,
    catalog: LoadedCatalog,
  ): AsyncGenerator<ChatStreamEvent> {
    const wasEscalated = ticket.state === 'escalated';
    if (wasEscalated && ticket.externalId && this.d.helpdesk.closeRequest) {
      try {
        await this.d.helpdesk.closeRequest(ticket.externalId, 'Закрыто пользователем из чата');
      } catch (err) {
        this.d.log.warn(
          { ticketId: ticket.id, err: (err as Error).message },
          'helpdesk request close failed',
        );
      }
    }
    ticket = await this.d.tickets.update(ticket.id, {
      state: 'closed',
      closedBy: 'user',
      closedAt: new Date(),
      pendingEscalation: null,
      pendingField: null,
    });
    const card = toCard(ticket, catalog);
    this.d.log.info({ ticketId: ticket.id, wasEscalated }, 'ticket closed by user');
    await this.d.events.publish(TOPICS.ticketEvents, ticket.id, {
      ...eventBase(ticket.id, user.id),
      type: 'ticket.closed',
      by: 'user',
      ticket: card,
    });
    yield { type: 'meta', ticket: card };
    yield* this.reply(ticket, catalog, T.closedByUser(card), QR_CLOSED);
  }

  /** AI: То же, что команда в чате, - для REST-эндпоинта за кнопкой «Закрыть обращение». */
  async closeByUser(
    ticket: TicketRow,
    user: UserRow,
    scope: Scope = 'full',
  ): Promise<{ ticket: TicketCard; message: ChatMessage }> {
    const catalog = await this.d.knowledge.catalog(ticket.tenantId, scope);
    await this.d.tickets.addMessage(ticket.id, 'user', 'Закрыть обращение', { command: CMD.close });
    let last: { ticket: TicketCard; message: ChatMessage } | null = null;
    for await (const ev of this.withdraw(ticket, user, catalog)) {
      if (ev.type === 'done') last = { ticket: ev.ticket, message: ev.message };
    }
    if (!last) throw new Error('withdraw produced no message');
    return last;
  }

  private async setCategory(
    ticket: TicketRow,
    user: UserRow,
    catalog: LoadedCatalog,
    categoryId: string,
    confidence: number,
  ): Promise<TicketRow> {
    const category = catalog.categoryById.get(categoryId)!;
    const updated = await this.d.tickets.update(ticket.id, {
      categoryId,
      confidence,
      state: 'intake',
      priority: maxPriority(ticket.priority, category.priority),
    });
    await this.d.events.publish(TOPICS.ticketEvents, ticket.id, {
      ...eventBase(ticket.id, user.id),
      type: 'ticket.classified',
      categoryId,
      confidence,
      tone: updated.tone as Tone,
    });
    return updated;
  }

  // ---------- вспомогательные ----------

  /** AI: Сохранить сообщение помощника и выдать `done`. */
  private async *reply(
    ticket: TicketRow,
    catalog: LoadedCatalog,
    text: string,
    quickReplies?: QuickReply[],
  ): AsyncGenerator<ChatStreamEvent> {
    yield { type: 'delta', text };
    yield* this.finish(ticket, catalog, text, quickReplies);
  }

  private async *finish(
    ticket: TicketRow,
    catalog: LoadedCatalog,
    text: string,
    quickReplies?: QuickReply[],
    meta: Record<string, unknown> = {},
  ): AsyncGenerator<ChatStreamEvent> {
    // AI: Единственная точка контроля: гость никогда не увидит кнопку, ведущую к специалисту.
    const visible =
      catalog.scope === 'guest'
        ? (quickReplies ?? []).filter((q) => q.value !== CMD.human && q.value !== CMD.escalate)
        : (quickReplies ?? []);
    const saved = await this.d.tickets.addMessage(ticket.id, 'assistant', text, {
      ...meta,
      quickReplies: visible,
    });
    const fresh = (await this.d.tickets.get(ticket.id, ticket.userId)) ?? ticket;
    yield {
      type: 'done',
      message: {
        id: saved.id,
        role: 'assistant',
        content: text,
        createdAt: saved.createdAt.toISOString(),
        ...(visible.length ? { quickReplies: visible } : {}),
      },
      ticket: toCard(fresh, catalog),
    };
  }

  private async history(
    ticketId: string,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const rows = await this.d.tickets.listMessages(ticketId, this.d.config.historyTurns * 2 + 1);
    return rows
      .filter((m) => m.role !== 'system')
      .slice(0, -1) // the last row is the message being processed now
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  }

  /**
   * AI: Понимание без модели: лексическое совпадение с базой знаний определяет категорию и
   * уверенность.
   */
  private async fallbackAnalyze(
    catalog: LoadedCatalog,
    ticket: TicketRow,
    text: string,
  ): Promise<Analysis> {
    const hits = await this.d.knowledge.search(ticket.tenantId, text, { limit: 3 });
    const best = hits[0];
    const categoryId = ticket.categoryId ?? best?.article.categoryId ?? 'unknown';
    const confidence = ticket.categoryId ? 1 : best ? Math.min(0.95, 0.5 + best.score / 10) : 0;
    const lower = text.toLowerCase();
    const offTopic = isSmalltalk(text) || (!ticket.categoryId && !best);
    // AI: Заполняем поля уточнения, чьи варианты названы буквально («из дома» -> location).
    const fields: Record<string, string> = {};
    const category = catalog.categoryById.get(categoryId);
    for (const f of category?.clarify ?? []) {
      const hit = f.options?.find((o) => optionMentioned(o, lower));
      if (hit) fields[f.id] = hit;
    }
    return {
      categoryId,
      confidence,
      summary: offTopic ? (ticket.summary ?? '') : (ticket.summary ?? text.slice(0, 160)),
      fields,
      tone: 'neutral',
      offTopic,
      smalltalkReply: offTopic ? T.smalltalk(text) : undefined,
      reportsResolved:
        /помогло|заработал|решилось|всё работает|все работает|спасибо, работает/.test(lower),
      asksForHuman: /оператор|специалист|живой человек|человека/.test(lower),
    };
  }
}

// AI: Один или несколько разговорных токенов («ок, спасибо!») и ничего больше.
const SMALLTALK =
  /^(?:(?:привет|приветствую|здравствуй(?:те)?|добрый (?:день|вечер|утро)|доброе утро|хай|hi|hello|hey|ты тут|ты здесь|есть кто|ау|эй|как дела|кто ты|ты кто|что ты умеешь|спасибо|спс|благодарю|ок|окей|ok|понял|пон|ясно|хорошо|ладно|пока|до свидания|тест|test|проверка)[\s!?.,)]*){1,3}$/i;

/**
 * AI: Короткое сообщение специалисту, которое читается как «уже не нужно»: помощник спрашивает,
 * закрыть ли. Длинные сообщения не трогаем - там могут лишь упоминать закрытие чего-то другого.
 */
function looksLikeWithdrawal(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 120) return false;
  return WITHDRAWAL.test(t);
}

const WITHDRAWAL =
  /не\s?актуальн|закр(ой|ыть|ывай)те? (обращение|заявку|вопрос)|отмен(и|ить|яю) (обращение|заявку)|больше не (нужно|надо|требуется)|уже (решил|решилось|разобрал|не нужно|не надо)|само (решилось|заработало)|вопрос (снят|закрыт)/;

/** AI: «Где / как / когда / сколько …?» - вопрос, а не отзыв о шагах. */
function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t.endsWith('?') ||
    /(^|[^а-яё])(как|где|когда|какой|какая|какие|каких|каком|сколько|кто|что|можно ли|есть ли|куда|почему|зачем)([^а-яё]|$)/.test(
      t,
    )
  );
}

/**
 * AI: Суть на карточке должна описывать проблему. Модель иногда повторяет болтовню («ты тут?») или
 * возвращает заглушку; такие значения отбрасываются, прежняя суть сохраняется.
 */
function soberSummary(raw: string | undefined): string | undefined {
  const s = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (s.length < 8) return undefined;
  if (isSmalltalk(s) || /^(ты тут|ты здесь|есть кто|привет|тест|проверка)/i.test(s))
    return undefined;
  if (/^(нет|не указано|неизвестно|n\/a|null|none)$/i.test(s)) return undefined;
  // AI: «Просит связать с оператором» - это не проблема, а просьба; карточке она не нужна.
  if (
    /(связ|соедин|позов|позва|подключ|нужен|хочет|просит|хочу)[^.]{0,40}(оператор|специалист|человек)/i.test(
      s,
    )
  )
    return undefined;
  return s.slice(0, 300);
}

function isSmalltalk(text: string): boolean {
  return text.trim().length <= 40 && SMALLTALK.test(text.trim());
}

/** AI: Маркер, который выдаёт модель, когда найденная статья не подходит к проблеме. */
const NO_SOLUTION = '[NO_SOLUTION]';
/** AI: Ниже этого балла BM25 лучшая статья - шум, а не совпадение. */
const MIN_SOLUTION_SCORE = 1.5;

const NEGATIVE =
  /не помог|не работает|не получ|не подключ|не заход|не откр|не вход|всё равно|все равно|по-прежнему|опять|снова|ошибк|та же|тоже самое|то же самое|ничего/;

function cleanFields(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    const val = String(v ?? '').trim();
    if (val && val.toLowerCase() !== 'null' && val !== '-' && val !== '—')
      out[k] = val.slice(0, 200);
  }
  return out;
}

function bumpPriority(current: string, tone: Tone): string {
  if (tone === 'neutral') return current;
  return 'high';
}

function maxPriority(a: string, b: string): string {
  const rank: Record<string, number> = { low: 0, normal: 1, high: 2 };
  return (rank[a] ?? 1) >= (rank[b] ?? 1) ? a : b;
}

function labelFor(cmd: string, catalog: LoadedCatalog): string {
  if (cmd === CMD.helped) return 'Помогло';
  if (cmd === CMD.notHelped) return 'Не помогло';
  if (cmd === CMD.human) return 'Нужен специалист';
  if (cmd === CMD.escalate) return 'Создать заявку специалисту';
  if (cmd === CMD.dismiss) return 'Не нужно';
  if (cmd === CMD.close) return 'Закрыть обращение';
  if (cmd === CMD.next) return 'Следующий вопрос';
  if (cmd.startsWith(CMD.pick)) return `Сначала: вопрос ${Number(cmd.slice(CMD.pick.length)) + 1}`;
  if (cmd === CMD.keep) return 'Оставить';
  if (cmd.startsWith(CMD.category))
    return catalog.categoryById.get(cmd.slice(CMD.category.length))?.name ?? cmd;
  return cmd;
}

export type { TicketCard };
