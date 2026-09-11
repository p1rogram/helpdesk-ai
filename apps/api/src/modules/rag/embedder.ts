/**
 * AI: Плотные эмбеддинги за крошечным интерфейсом. По умолчанию - локальная ONNX-модель
 * (multilingual-e5-small, 384 измерения) внутри процесса API через transformers.js: без внешнего
 * сервиса, без ключа, который можно утечь, ~30 мс на батч на CPU. Замените класс, чтобы
 * использовать pgvector + внешний API эмбеддингов, не трогая код поиска.
 */
export interface Embedder {
  readonly model: string;
  readonly dims: number;
  /** AI: Моделям e5 нужен префикс роли - запросы и пассажи векторизуются по-разному. */
  embed(texts: string[], kind: 'query' | 'passage'): Promise<number[][]>;
}

export class NullEmbedder implements Embedder {
  readonly model = 'none';
  readonly dims = 0;
  async embed(): Promise<number[][]> {
    return [];
  }
}

type Pipeline = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export class LocalEmbedder implements Embedder {
  readonly model: string;
  readonly dims = 384;
  private pipe: Promise<Pipeline> | null = null;

  constructor(
    private readonly opts: { model?: string; cacheDir: string; log: { info: (m: string) => void } },
  ) {
    this.model = opts.model ?? 'Xenova/multilingual-e5-small';
  }

  /** AI: Лениво: модель (~30 МБ, квантованная) скачивается один раз и кэшируется на диске. */
  private load(): Promise<Pipeline> {
    if (!this.pipe) {
      this.pipe = (async () => {
        const started = Date.now();
        const tf = await import('@huggingface/transformers');
        tf.env.cacheDir = this.opts.cacheDir;
        const p = (await tf.pipeline('feature-extraction', this.model, {
          dtype: 'q8',
        })) as unknown as Pipeline;
        this.opts.log.info(`embeddings: ${this.model} ready in ${Date.now() - started} ms`);
        return p;
      })();
      this.pipe.catch(() => {
        this.pipe = null; // retry on the next call instead of caching the failure forever
      });
    }
    return this.pipe;
  }

  async embed(texts: string[], kind: 'query' | 'passage'): Promise<number[][]> {
    if (!texts.length) return [];
    const pipe = await this.load();
    const out: number[][] = [];
    // AI: Батчи держат память ровной при индексации тысяч фрагментов.
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16).map((t) => `${kind}: ${t}`);
      const res = await pipe(batch, { pooling: 'mean', normalize: true });
      out.push(...res.tolist());
    }
    return out;
  }
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s; // vectors are L2-normalised, so the dot product is the cosine
}
