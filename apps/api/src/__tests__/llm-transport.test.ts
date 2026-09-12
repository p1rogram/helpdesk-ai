import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmService } from '../modules/llm/index.js';
import type { LoadedCatalog } from '../modules/knowledge/index.js';

/**
 * AI: Мини-сервер, притворяющийся локальной моделью с OpenAI-совместимым API (как vLLM / Ollama):
 * без стрима отвечает JSON-анкетой, со стримом - кусками текста в формате SSE.
 */
let server: Server;
let baseURL = '';
const seen: Array<{ path: string; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ path: req.url ?? '', body });
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const piece of ['1. Перезагрузите ', 'роутер\n', '2. Проверьте кабель']) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 12 } })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const analysis = {
        categoryId: 'network',
        confidence: 0.88,
        summary: 'Не работает Wi-Fi в общежитии',
        fields: { location: 'Из общежития' },
        tone: 'neutral',
        offTopic: false,
        reportsResolved: false,
        asksForHuman: false,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '```json\n' + JSON.stringify(analysis) + '\n```' } }],
          usage: { prompt_tokens: 300, completion_tokens: 60 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseURL = `http://127.0.0.1:${addr.port}/v1`;
});

afterAll(async () => new Promise<void>((r) => server.close(() => r())));

const catalog = {
  sphere: 'Тест',
  organisation: 'Тестовая организация',
  categories: [],
  articles: [],
  categoryById: new Map(),
  articleById: new Map(),
  version: 1,
  scope: 'full',
} as unknown as LoadedCatalog;

describe('LlmService with a local OpenAI-compatible model', () => {
  it('is enabled without an API key and talks to /chat/completions', async () => {
    const usages: string[] = [];
    const llm = new LlmService({
      provider: 'openai',
      baseURL,
      model: 'qwen2.5-14b-instruct',
      effort: 'low',
      timeoutMs: 5000,
      log: { warn() {}, debug() {} },
      onUsage: (u) => usages.push(`${u.operation}:${u.inputTokens}/${u.outputTokens}`),
    });
    expect(llm.enabled).toBe(true);
    expect(llm.provider).toBe('openai');

    // AI: Анкета в ограждении ```json разбирается терпимо и проходит схему.
    const a = await llm.analyze(catalog, {
      history: [],
      message: 'не работает вайфай',
      knownFields: {},
    });
    expect(a.categoryId).toBe('network');
    expect(a.fields.location).toBe('Из общежития');
    expect(seen[0]!.path).toBe('/v1/chat/completions');
    expect(seen[0]!.body.model).toBe('qwen2.5-14b-instruct');
    expect((seen[0]!.body.response_format as { type: string }).type).toBe('json_object');

    // AI: Стрим приходит кусками, usage - из последнего события.
    const chunks: string[] = [];
    for await (const c of llm.solve(catalog, {
      summary: 'x',
      category: {
        id: 'network',
        name: 'Сеть',
        description: '',
        priority: 'normal',
        clarify: [],
        escalation: 'operator',
      },
      fields: {},
      article: {
        id: 'a',
        categoryId: 'network',
        title: 't',
        symptoms: 's',
        steps: ['1'],
        escalateAfter: false,
        audience: 'internal',
      },
      tone: 'neutral',
      lastMessage: 'x',
    }))
      chunks.push(c);
    expect(chunks.join('')).toBe('1. Перезагрузите роутер\n2. Проверьте кабель');
    expect(usages).toEqual(['analyze:300/60', 'solve:40/12']);
  });

  it('stays disabled for the cloud provider without a key', () => {
    const llm = new LlmService({
      provider: 'anthropic',
      baseURL: 'https://api.anthropic.com',
      model: 'claude-opus-5',
      effort: 'low',
      timeoutMs: 5000,
      log: { warn() {}, debug() {} },
    });
    expect(llm.enabled).toBe(false);
  });
});
