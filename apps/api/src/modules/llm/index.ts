import {
  AnalysisSchema,
  type Analysis,
  type Category,
  type KbArticle,
  type Tone,
} from '@helpdesk/shared';
import type { LoadedCatalog } from '../knowledge/index.js';
import { extractJson } from './json.js';
import {
  analyzeSystemPrompt,
  analyzeUserPrompt,
  answerSystemPrompt,
  answerUserPrompt,
  solveSystemPrompt,
  solveUserPrompt,
} from './prompts.js';
import type { Passage } from '../rag/index.js';
import { createTransport, type LlmProvider, type LlmTransport } from './transport.js';

export type { LlmProvider } from './transport.js';

export interface LlmUsage {
  operation: 'analyze' | 'solve' | 'answer';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
}

export interface LlmOptions {
  /** AI: anthropic (облако / агрегатор) или openai (локальный сервер модели). */
  provider?: LlmProvider;
  apiKey?: string;
  /** AI: Принудительно без модели (см. withoutModel). */
  disabled?: boolean;
  baseURL: string;
  model: string;
  /**
   * AI: Анкету (категория, поля, флаги) может заполнять модель побыстрее и подешевле, чем та, что
   * формулирует ответ: вызов №1 - на пути каждого сообщения, его задержка заметнее всего.
   */
  analyzeModel?: string;
  effort: 'low' | 'medium' | 'high';
  timeoutMs: number;
  onUsage?: (usage: LlmUsage) => void;
  log: { warn(obj: unknown, msg?: string): void; debug(obj: unknown, msg?: string): void };
}

export class LlmUnavailableError extends Error {
  constructor(
    msg: string,
    override readonly cause?: unknown,
  ) {
    super(msg);
    this.name = 'LlmUnavailableError';
  }
}

/**
 * AI: Тонкий сервис над транспортом к модели. Только три операции:
 *  - analyze(): структурированный вывод (категория, уверенность, поля, тон...) - без стрима
 *  - solve():   стрим markdown строго по ОДНОЙ статье базы знаний
 *  - answer():  стрим markdown по найденным фрагментам документации (RAG)
 * Какая модель за транспортом - облачный Claude или локальная на сервере университета - решает
 * конфиг (LLM_PROVIDER); промпты и движок этого не знают. Ключ API живёт только здесь, на сервере.
 * Ошибки превращаются в LlmUnavailableError, чтобы движок мог откатиться к детерминированному
 * поведению (шаги статьи дословно) и никогда не ронял чат.
 */
export class LlmService {
  private readonly transport: LlmTransport | null;
  readonly enabled: boolean;
  readonly provider: LlmProvider;

  constructor(private readonly opts: LlmOptions) {
    this.provider = opts.provider ?? 'anthropic';
    // AI: Облаку нужен ключ; локальному серверу - нет (адрес достаточно).
    this.enabled =
      !opts.disabled && (this.provider === 'openai' ? Boolean(opts.baseURL) : Boolean(opts.apiKey));
    this.transport = this.enabled
      ? createTransport(this.provider, {
          apiKey: opts.apiKey,
          baseURL: opts.baseURL,
          model: opts.model,
          effort: opts.effort,
          timeoutMs: opts.timeoutMs,
        })
      : null;
  }

  /** AI: Тот же сервис, но модель выключена: для запросов сверх бюджета. */
  withoutModel(): LlmService {
    return new LlmService({ ...this.opts, disabled: true });
  }

  async analyze(
    catalog: LoadedCatalog,
    input: {
      history: Array<{ role: 'user' | 'assistant'; content: string }>;
      message: string;
      knownFields: Record<string, string>;
      fixedCategoryId?: string;
    },
  ): Promise<Analysis> {
    if (!this.transport) throw new LlmUnavailableError('LLM disabled (no API key / no server)');
    const started = Date.now();
    try {
      const res = await this.transport.complete(
        analyzeSystemPrompt(catalog),
        analyzeUserPrompt(input),
        {
          maxTokens: 1024,
          json: true,
          model: this.opts.analyzeModel,
        },
      );
      this.report('analyze', res.usage, started);
      if (res.refusal) throw new LlmUnavailableError('analyze: refusal');
      const parsed = AnalysisSchema.safeParse(extractJson(res.text));
      if (!parsed.success) {
        this.opts.log.warn(
          { issues: parsed.error.issues.slice(0, 3), sample: res.text.slice(0, 200) },
          'analyze: invalid JSON from model',
        );
        throw new LlmUnavailableError('analyze: invalid structured output');
      }
      return parsed.data;
    } catch (err) {
      throw this.wrap(err, 'analyze');
    }
  }

  /**
   * AI: Стримит куски markdown-текста. Бросает LlmUnavailableError (возможно, посреди стрима) -
   * вызывающий код решает, откатываться ли к шагам статьи дословно.
   */
  async *solve(
    catalog: LoadedCatalog,
    input: {
      summary: string;
      category: Category;
      fields: Record<string, string>;
      article: KbArticle;
      tone: Tone;
      lastMessage: string;
      passages?: Passage[];
    },
  ): AsyncGenerator<string, void, void> {
    yield* this.streamMarkdown('solve', solveSystemPrompt(catalog), solveUserPrompt(input));
  }

  /**
   * AI: RAG: ответ только по найденным фрагментам. Тот же контракт стрима/отката, что у solve().
   */
  async *answer(
    catalog: LoadedCatalog,
    input: {
      summary: string;
      categoryName?: string;
      fields: Record<string, string>;
      tone: Tone;
      lastMessage: string;
      passages: Passage[];
    },
  ): AsyncGenerator<string, void, void> {
    yield* this.streamMarkdown('answer', answerSystemPrompt(catalog), answerUserPrompt(input));
  }

  private async *streamMarkdown(
    op: 'solve' | 'answer',
    system: string,
    user: string,
  ): AsyncGenerator<string, void, void> {
    if (!this.transport) throw new LlmUnavailableError('LLM disabled (no API key / no server)');
    const started = Date.now();
    try {
      const final = yield* this.transport.stream(system, user, { maxTokens: 2048 });
      this.report(op, final.usage, started);
      if (final.refusal) throw new LlmUnavailableError(`${op}: refusal`);
    } catch (err) {
      throw this.wrap(err, op);
    }
  }

  private report(
    operation: LlmUsage['operation'],
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    },
    started: number,
  ) {
    const u: LlmUsage = {
      operation,
      model:
        operation === 'analyze' ? (this.opts.analyzeModel ?? this.opts.model) : this.opts.model,
      ...usage,
      latencyMs: Date.now() - started,
    };
    this.opts.log.debug(u, 'llm usage');
    this.opts.onUsage?.(u);
  }

  private wrap(err: unknown, op: string): Error {
    if (err instanceof LlmUnavailableError) return err;
    const d = this.transport?.describeError(err) ?? {
      kind: 'other' as const,
      message: String(err),
    };
    this.opts.log.warn(
      { op, provider: this.provider, kind: d.kind, message: d.message },
      'llm error',
    );
    return new LlmUnavailableError(d.message, err);
  }
}
