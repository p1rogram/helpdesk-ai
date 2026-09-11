import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
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
  apiKey?: string;
  baseURL: string;
  model: string;
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
 * AI: Тонкий сервис над Anthropic SDK. Только три операции:
 *  - analyze(): структурированный вывод (категория, уверенность, поля, тон...) - без стрима
 *  - solve():   стрим markdown строго по ОДНОЙ статье базы знаний
 *  - answer():  стрим markdown по найденным фрагментам документации (RAG)
 * Ключ API живёт только здесь, на сервере. Ошибки превращаются в LlmUnavailableError, чтобы движок
 * мог откатиться к детерминированному поведению (шаги статьи дословно) и никогда не ронял чат.
 */
export class LlmService {
  private readonly client: Anthropic | null;
  readonly enabled: boolean;

  constructor(private readonly opts: LlmOptions) {
    this.enabled = Boolean(opts.apiKey);
    this.client = this.enabled
      ? new Anthropic({
          apiKey: opts.apiKey,
          baseURL: opts.baseURL,
          timeout: opts.timeoutMs,
          maxRetries: 1,
        })
      : null;
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
    if (!this.client) throw new LlmUnavailableError('LLM disabled (no API key)');
    const started = Date.now();
    try {
      // AI: Структурированный вывод запрашивается через output_config (его обеспечивает Anthropic
      // API) И промпт просит голый JSON; результат разбирается терпимо, чтобы шлюзы/прокси,
      // игнорирующие json_schema, всё равно давали валидный объект (ограждения кода и текст вокруг
      // JSON отбрасываются).
      const res = await this.client.messages.create({
        model: this.opts.model,
        max_tokens: 1024,
        // AI: Стабильный префикс -> попадание в prompt cache на каждом запросе этого тенанта /
        // версии каталога.
        system: [
          {
            type: 'text',
            text: analyzeSystemPrompt(catalog),
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: analyzeUserPrompt(input) }],
        thinking: { type: 'adaptive' },
        output_config: { effort: this.opts.effort, format: zodOutputFormat(AnalysisSchema) },
      });
      this.report('analyze', res.usage, started);
      if (res.stop_reason === 'refusal') throw new LlmUnavailableError('analyze: refusal');
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const parsed = AnalysisSchema.safeParse(extractJson(text));
      if (!parsed.success) {
        this.opts.log.warn(
          { issues: parsed.error.issues.slice(0, 3), sample: text.slice(0, 200) },
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
    if (!this.client) throw new LlmUnavailableError('LLM disabled (no API key)');
    const started = Date.now();
    try {
      const stream = this.client.messages.stream({
        model: this.opts.model,
        max_tokens: 2048,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        thinking: { type: 'adaptive' },
        output_config: { effort: this.opts.effort },
      });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text;
        }
      }
      const final = await stream.finalMessage();
      this.report(op, final.usage, started);
      if (final.stop_reason === 'refusal') {
        throw new LlmUnavailableError(`${op}: refusal`);
      }
    } catch (err) {
      throw this.wrap(err, op);
    }
  }

  private report(operation: LlmUsage['operation'], usage: Anthropic.Usage, started: number) {
    const u: LlmUsage = {
      operation,
      model: this.opts.model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
    this.opts.log.debug(u, 'llm usage');
    this.opts.onUsage?.(u);
  }

  private wrap(err: unknown, op: string): Error {
    if (err instanceof LlmUnavailableError) return err;
    if (err instanceof Anthropic.RateLimitError) {
      this.opts.log.warn({ op }, 'llm rate limited');
      return new LlmUnavailableError('rate limited', err);
    }
    if (err instanceof Anthropic.AuthenticationError) {
      this.opts.log.warn({ op }, 'llm auth error - check ANTHROPIC_API_KEY');
      return new LlmUnavailableError('auth error', err);
    }
    if (err instanceof Anthropic.APIError || err instanceof Anthropic.APIConnectionError) {
      this.opts.log.warn(
        { op, status: (err as { status?: number }).status, message: err.message },
        'llm api error',
      );
      return new LlmUnavailableError(err.message, err);
    }
    this.opts.log.warn({ op, err }, 'llm unexpected error');
    return new LlmUnavailableError('unexpected error', err);
  }
}
