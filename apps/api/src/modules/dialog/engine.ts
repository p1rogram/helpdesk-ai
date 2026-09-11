import type {
  Analysis,
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
import { extractFields } from './extract.js';
import { inspectMessage, strongerTone } from '../safety/index.js';
import { toCard, type TicketRepository } from '../tickets/repository.js';
import type { HelpdeskConnector } from '../helpdesk/index.js';
import {
  CMD,
  QR_AFTER_SOLUTION,
  QR_CLOSED,
  QR_CLOSED_OR_NEW,
  QR_HELPED_ONLY,
  QR_NEW_ONLY,
  QR_OFFER_ESCALATION,
  T,
  type EscalationReason,
} from './templates.js';

export interface EngineConfig {
  maxClarifications: number;
  confidenceThreshold: number;
  historyTurns: number;
}

export interface EngineDeps {
  knowledge: KnowledgeService;
  /** AI: Documentation retrieval for questions the curated catalog does not cover; null = off. */
  rag: RagService | null;
  llm: LlmService;
  tickets: TicketRepository;
  events: EventBus;
  helpdesk: HelpdeskConnector;
  config: EngineConfig;
  log: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void };
}

/**
 * AI: The dialog engine is a deterministic state machine. The LLM is consulted for exactly two
 * things - understanding the message (structured) and phrasing a grounded solution - and
 * every decision (ask / solve / escalate / close) is made here, in code. That makes the
 * behaviour testable, cheap and impossible to talk out of its role.
 *
 * States: intake -> clarifying* -> solving -> closed | escalated  (choosing_category on low confidence)
 */
export class DialogEngine {
  constructor(private readonly d: EngineDeps) {}

  async *handle(
    ticket: TicketRow,
    user: UserRow,
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

    // AI: A specialist owns this dialogue: the assistant must not speak over them. The message is
    // stored and pushed to the operator console; the client gets a silent acknowledgement.
    if (ticket.state === 'escalated') {
      if (isCmd) {
        yield* this.reply(ticket, catalog, T.withOperator(), QR_CLOSED);
        return;
      }
      const touched = await this.d.tickets.update(ticket.id, { updatedAt: new Date() });
      await this.d.events.publish(TOPICS.ticketEvents, ticket.id, {
        ...eventBase(ticket.id, user.id),
        type: 'ticket.updated',
        tenantId: ticket.tenantId,
      });
      yield { type: 'ack', ticket: toCard(touched, catalog) };
      return;
    }
    // AI: Closed tickets do not continue - the client offers "new ticket".
    if (ticket.state === 'closed') {
      yield* this.reply(ticket, catalog, T.closedHint(), QR_CLOSED);
      return;
    }

    yield { type: 'meta', ticket: toCard(ticket, catalog) };

    // ---------- engine commands (buttons) ----------
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
    if (text === CMD.human || text === CMD.escalate) {
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
        // AI: The operator already reviewed this ticket and sent it back - do not re-queue it.
        yield* this.reply(
          ticket,
          catalog,
          T.escalationBlocked(),
          ticket.articleId ? QR_HELPED_ONLY : QR_NEW_ONLY,
        );
        return;
      }
      const reason: EscalationReason =
        text === CMD.escalate
          ? ((ticket.pendingEscalation as EscalationReason | null) ?? 'user_request')
          : 'user_request';
      yield* this.escalate(ticket, user, catalog, reason);
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
      // AI: Unknown / stale command - ignore politely.
      yield* this.reply(
        ticket,
        catalog,
        T.afterSolution(),
        ticket.state === 'solving' ? QR_AFTER_SOLUTION : undefined,
      );
      return;
    }

    // ---------- quick-reply answer to a clarifying question: no LLM needed ----------
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
      // AI: The user kept typing instead of choosing: treat it as new information about the problem.
      ticket = await this.d.tickets.update(ticket.id, {
        state: ticket.articleId ? 'solving' : 'intake',
        pendingEscalation: null,
      });
    }

    // ---------- free text ----------
    // AI: Greetings / "are you there?" / thanks never need the model - answer instantly and warmly.
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
    const fields = { ...ticket.fields, ...cleanFields(analysis.fields) };
    if (ticket.state === 'clarifying' && ticket.pendingField && !fields[ticket.pendingField]) {
      // AI: The user answered our question in free form - keep the raw answer.
      fields[ticket.pendingField] = text.slice(0, 200);
    }
    // AI: Summary: never from chit-chat; refine while the problem is still being understood, freeze once solving.
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
    // AI: Card with the fresh summary goes out right away, so the client's history can list the
    // ticket while the answer is still being written.
    yield { type: 'meta', ticket: toCard(ticket, catalog) };

    if (analysis.asksForHuman) {
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
        yield* this.reply(
          ticket,
          catalog,
          T.escalationBlocked(),
          ticket.articleId ? QR_HELPED_ONLY : QR_NEW_ONLY,
        );
        return;
      }
      yield* this.escalate(ticket, user, catalog, 'user_request');
      return;
    }
    if ((analysis.reportsResolved && ticket.state === 'solving') || analysis.asksToClose) {
      // AI: An explicit "close it" finishes the request even before a solution was shown.
      yield* this.resolve(
        ticket,
        user,
        catalog,
        analysis.asksToClose === true ? 'user_request' : 'helped',
      );
      return;
    }
    if (analysis.offTopic && ticket.state !== 'solving') {
      yield* this.reply(ticket, catalog, analysis.smalltalkReply?.trim() || T.offTopic());
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
        // AI: Second miss in a row: do not loop, offer a hand-over with what we have.
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

    // AI: In "solving" state: a complaint means the steps did not help; a question is answered on the
    // spot (another article or the documentation); anything else is a detail we note.
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

  // ---------- transitions ----------

  /** AI: Ask the next required clarification or search for a solution. */
  private async *advance(
    ticket: TicketRow,
    user: UserRow,
    catalog: LoadedCatalog,
    lastText: string,
    llmDown = false,
  ): AsyncGenerator<ChatStreamEvent> {
    const category = catalog.categoryById.get(ticket.categoryId!)!;

    // AI: Pull identifiers the user already named (dorm number, room) out of the message before
    // deciding what to ask - and stop early if the value cannot exist (e.g. a dorm that was never built).
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

    const missing = category.clarify.filter((f) => f.required && !ticket.fields[f.id]);
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
        T.clarify(field.question),
        T.clarifyButtons(field.options),
      );
      return;
    }
    yield* this.solve(ticket, user, catalog, lastText, llmDown);
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
      // AI: No vetted article - try the documentation corpus before giving up.
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
    // AI: Documentation fragments enrich the article with facts (addresses, phones, deadlines).
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
      // AI: The model judged the best article irrelevant: do not show it, do not retrieve it again.
      // Try the documentation corpus, then offer a hand-over honestly.
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
      // AI: Deterministic fallback: article steps verbatim. The chat never dies with the LLM.
      const fb = (streamed.trim() ? '\n\n' : '') + T.solutionFallback(article);
      streamed += fb;
      yield { type: 'delta', text: fb };
    }
    text += streamed.trim();

    if (article.escalateAfter) {
      // AI: The article itself says a specialist finishes the job: deliver the steps, then ask
      // whether to create the request (two `done` events; the client appends both).
      yield* this.finish(ticket, catalog, text, undefined, { articleId: article.id });
      yield* this.offerEscalation(ticket, catalog, 'article_requires_specialist');
      return;
    }
    const tail = '\n\n' + T.afterSolution();
    yield { type: 'delta', text: tail };
    yield* this.finish(ticket, catalog, text + tail, QR_AFTER_SOLUTION, { articleId: article.id });
  }

  /** AI: Hybrid retrieval over the crawled documentation, scoped to what this session may see. */
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
   * AI: RAG path: answer from documentation fragments when no catalog article fits. Returns true
   * when an answer was delivered; false (nothing relevant / model said [NO_SOLUTION] / LLM down)
   * lets the caller fall through to the hand-over offer. Nothing is shown unless it is grounded.
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
   * AI: Streams model output to the client, holding back the first characters until it is clear
   * the answer does not start with [NO_SOLUTION]. Returns what was shown; `failed` means the model
   * went away mid-way (the caller decides how to fall back).
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
   * AI: A question asked while a solution is on screen ("а где находится деканат?") is answered
   * from the best-matching article across the whole catalog, or from the documentation; the
   * current solution and its buttons stay in place.
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
    yield* this.reply(ticket, catalog, T.noted(), QR_AFTER_SOLUTION);
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
    // AI: Only offer a second article when it is a comparable match to the best one; otherwise stop guessing.
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
    yield* this.reply(ticket, catalog, T.resolved(card, reason), QR_CLOSED);
  }

  /**
   * AI: The assistant never creates a request on its own: it explains why it cannot go further and
   * asks. Only an explicit "yes" (or the user asking for a human) creates the external request.
   */
  private async *offerEscalation(
    ticket: TicketRow,
    catalog: LoadedCatalog,
    reason: EscalationReason,
  ): AsyncGenerator<ChatStreamEvent> {
    if (catalog.scope === 'guest') {
      // AI: No request and no operator for guests - explain how to get one, keep the dialogue open.
      yield* this.reply(
        ticket,
        catalog,
        T.guestNoEscalation(reason),
        ticket.articleId ? QR_HELPED_ONLY : undefined,
      );
      return;
    }
    if (ticket.escalationBlocked) {
      // AI: A specialist decided this ticket stays with the assistant; never offer to escalate again.
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

  private async *escalate(
    ticket: TicketRow,
    user: UserRow,
    catalog: LoadedCatalog,
    reason: EscalationReason,
  ): AsyncGenerator<ChatStreamEvent> {
    if (catalog.scope === 'guest') {
      yield* this.reply(ticket, catalog, T.guestNoEscalation(reason));
      return;
    }
    yield { type: 'status', text: 'Создаю заявку…' };
    // AI: Create the request in the external helpdesk first, so the card shows the real number.
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
      // AI: The chat must not fail because the helpdesk is down: keep the internal id, retry later via events.
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
    yield* this.reply(ticket, catalog, T.escalated(card, reason), QR_CLOSED);
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

  // ---------- helpers ----------

  /** AI: Save an assistant message and emit `done`. */
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
    // AI: Single choke point: a guest never sees a button that leads to a specialist.
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

  /** AI: LLM-less understanding: lexical match against the KB decides category and confidence. */
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
    // AI: Fill clarifying fields whose options are literally mentioned ("из дома" -> location).
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

// AI: One or several chit-chat tokens ("ок, спасибо!") and nothing else.
const SMALLTALK =
  /^(?:(?:привет|приветствую|здравствуй(?:те)?|добрый (?:день|вечер|утро)|доброе утро|хай|hi|hello|hey|ты тут|ты здесь|есть кто|ау|эй|как дела|кто ты|ты кто|что ты умеешь|спасибо|спс|благодарю|ок|окей|ok|понял|пон|ясно|хорошо|ладно|пока|до свидания|тест|test|проверка)[\s!?.,)]*){1,3}$/i;

/** AI: "Где / как / когда / сколько …?" - a question, not feedback on the steps. */
function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t.endsWith('?') ||
    /^(а |и )?(как|где|когда|какой|какая|какие|сколько|кто|что|можно ли|куда|почему)\b/.test(t)
  );
}

/**
 * AI: The card summary must describe a problem. The model occasionally echoes chit-chat
 * ("ты тут?") or returns a stub; such values are dropped and the previous summary is kept.
 */
function soberSummary(raw: string | undefined): string | undefined {
  const s = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (s.length < 8) return undefined;
  if (isSmalltalk(s) || /^(ты тут|ты здесь|есть кто|привет|тест|проверка)/i.test(s))
    return undefined;
  if (/^(нет|не указано|неизвестно|n\/a|null|none)$/i.test(s)) return undefined;
  return s.slice(0, 300);
}

function isSmalltalk(text: string): boolean {
  return text.trim().length <= 40 && SMALLTALK.test(text.trim());
}

/** AI: "Из дома / удалённо" is mentioned when any of its meaningful words appears in the text. */
function optionMentioned(option: string, lowerText: string): boolean {
  const words = option
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/)
    .filter((w) => w.length >= 3 && !['или', 'для', 'при', 'нет'].includes(w));
  return words.some((w) => lowerText.includes(w));
}

/** AI: Marker the model emits when the retrieved article does not fit the problem. */
const NO_SOLUTION = '[NO_SOLUTION]';
/** AI: Below this BM25 score the best article is noise, not a match. */
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
  if (cmd.startsWith(CMD.category))
    return catalog.categoryById.get(cmd.slice(CMD.category.length))?.name ?? cmd;
  return cmd;
}

export type { TicketCard };
