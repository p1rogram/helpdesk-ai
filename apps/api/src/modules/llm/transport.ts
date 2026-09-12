import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AnalysisSchema } from '@helpdesk/shared';

/**
 * AI: Транспорт к модели - единственное место, которое знает, «какая» это модель. Движок и
 * промпты одинаковы для облачного Claude и для локальной модели на сервере университета;
 * меняется только реализация двух вызовов: получить текст целиком и получить текст потоком.
 *
 *   anthropic - Anthropic Messages API (напрямую или через агрегатор с тем же форматом)
 *   openai    - любой сервер с OpenAI-совместимым /v1/chat/completions: vLLM, Ollama,
 *               llama.cpp, LM Studio, TGI - то есть локальная модель без ключа и без интернета
 */
export type LlmProvider = 'anthropic' | 'openai';

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Completion {
  text: string;
  usage: CompletionUsage;
  refusal: boolean;
}

export interface LlmTransport {
  readonly provider: LlmProvider;
  /** AI: Полный ответ; `json: true` - модель просят вернуть один JSON-объект по схеме анализа. */
  complete(
    system: string,
    user: string,
    opts: { maxTokens: number; json?: boolean },
  ): Promise<Completion>;
  /** AI: Поток текста; итог (usage, refusal) - в возвращаемом значении генератора. */
  stream(
    system: string,
    user: string,
    opts: { maxTokens: number },
  ): AsyncGenerator<string, Completion, void>;
  /** AI: Превращает ошибку транспорта в короткую причину для лога; null - ошибка не от модели. */
  describeError(err: unknown): { kind: 'rate_limit' | 'auth' | 'api' | 'other'; message: string };
}

export interface TransportOptions {
  baseURL: string;
  apiKey?: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export class AnthropicTransport implements LlmTransport {
  readonly provider = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(private readonly o: TransportOptions) {
    this.client = new Anthropic({
      apiKey: o.apiKey,
      baseURL: o.baseURL,
      timeout: o.timeoutMs,
      maxRetries: 1,
    });
  }

  async complete(
    system: string,
    user: string,
    opts: { maxTokens: number; json?: boolean },
  ): Promise<Completion> {
    // AI: Структурированный вывод запрашивается через output_config (его обеспечивает Anthropic
    // API) И промпт просит голый JSON; результат разбирается терпимо, чтобы шлюзы/прокси,
    // игнорирующие json_schema, всё равно давали валидный объект.
    const res = await this.client.messages.create({
      model: this.o.model,
      max_tokens: opts.maxTokens,
      // AI: Стабильный префикс -> попадание в prompt cache на каждом запросе этого тенанта /
      // версии каталога.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: this.o.effort,
        ...(opts.json ? { format: zodOutputFormat(AnalysisSchema) } : {}),
      },
    });
    return {
      text: res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
      usage: usageOf(res.usage),
      refusal: res.stop_reason === 'refusal',
    };
  }

  async *stream(
    system: string,
    user: string,
    opts: { maxTokens: number },
  ): AsyncGenerator<string, Completion, void> {
    const stream = this.client.messages.stream({
      model: this.o.model,
      max_tokens: opts.maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      thinking: { type: 'adaptive' },
      output_config: { effort: this.o.effort },
    });
    let text = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        yield event.delta.text;
      }
    }
    const final = await stream.finalMessage();
    return { text, usage: usageOf(final.usage), refusal: final.stop_reason === 'refusal' };
  }

  describeError(err: unknown) {
    if (err instanceof Anthropic.RateLimitError)
      return { kind: 'rate_limit' as const, message: err.message };
    if (err instanceof Anthropic.AuthenticationError)
      return { kind: 'auth' as const, message: 'check ANTHROPIC_API_KEY / LLM_API_KEY' };
    if (err instanceof Anthropic.APIError || err instanceof Anthropic.APIConnectionError)
      return {
        kind: 'api' as const,
        message: `${(err as { status?: number }).status ?? ''} ${err.message}`.trim(),
      };
    return { kind: 'other' as const, message: err instanceof Error ? err.message : String(err) };
  }
}

function usageOf(u: Anthropic.Usage): CompletionUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// OpenAI-совместимый сервер (локальная модель)
// ---------------------------------------------------------------------------

interface ChatChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * AI: Локальная модель через OpenAI-совместимый API. Без SDK - обычный fetch: так мы не зависим
 * от версии библиотеки и точно контролируем таймаут и разбор потока. Кэша промпта у таких серверов
 * может не быть - тогда cacheReadTokens = 0, это нормально.
 */
export class OpenAiCompatibleTransport implements LlmTransport {
  readonly provider = 'openai' as const;

  constructor(private readonly o: TransportOptions) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
    };
  }

  private body(system: string, user: string, maxTokens: number, extra: Record<string, unknown>) {
    return JSON.stringify({
      model: this.o.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      ...extra,
    });
  }

  private url(): string {
    return `${this.o.baseURL.replace(/\/$/, '')}/chat/completions`;
  }

  async complete(
    system: string,
    user: string,
    opts: { maxTokens: number; json?: boolean },
  ): Promise<Completion> {
    // AI: response_format json_object понимают vLLM / Ollama / llama.cpp; кто не понимает -
    // промпт всё равно просит голый JSON, а разбор терпимый.
    const res = await fetch(this.url(), {
      method: 'POST',
      headers: this.headers(),
      body: this.body(system, user, opts.maxTokens, {
        stream: false,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(this.o.timeoutMs),
    });
    if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''));
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    return {
      text: choice?.message?.content ?? '',
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      refusal: choice?.finish_reason === 'content_filter',
    };
  }

  async *stream(
    system: string,
    user: string,
    opts: { maxTokens: number },
  ): AsyncGenerator<string, Completion, void> {
    const res = await fetch(this.url(), {
      method: 'POST',
      headers: this.headers(),
      body: this.body(system, user, opts.maxTokens, {
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(this.o.timeoutMs * 4),
    });
    if (!res.ok || !res.body) throw new HttpError(res.status, await res.text().catch(() => ''));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage = { prompt_tokens: 0, completion_tokens: 0 };
    let refusal = false;
    // AI: SSE-поток: строки "data: {...}", последняя - "data: [DONE]".
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(payload) as ChatChunk;
        } catch {
          continue;
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          yield delta;
        }
        if (chunk.choices?.[0]?.finish_reason === 'content_filter') refusal = true;
        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens ?? 0,
            completion_tokens: chunk.usage.completion_tokens ?? 0,
          };
        }
      }
    }
    return {
      text,
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      refusal,
    };
  }

  describeError(err: unknown) {
    if (err instanceof HttpError) {
      if (err.status === 429) return { kind: 'rate_limit' as const, message: err.message };
      if (err.status === 401 || err.status === 403)
        return { kind: 'auth' as const, message: 'check LLM_API_KEY' };
      return { kind: 'api' as const, message: err.message };
    }
    return { kind: 'other' as const, message: err instanceof Error ? err.message : String(err) };
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`HTTP ${status} ${body.slice(0, 200)}`.trim());
  }
}

export function createTransport(provider: LlmProvider, o: TransportOptions): LlmTransport {
  return provider === 'openai' ? new OpenAiCompatibleTransport(o) : new AnthropicTransport(o);
}
