/**
 * AI: Dense embeddings behind a tiny interface. The default is a local ONNX model
 * (multilingual-e5-small, 384 dims) running inside the API process via transformers.js: no
 * external service, no key to leak, ~30 ms per batch on CPU. Swap the class to use pgvector +
 * a hosted embedding API without touching the retrieval code.
 */
export interface Embedder {
  readonly model: string;
  readonly dims: number;
  /** AI: e5 models want a role prefix - queries and passages are embedded differently. */
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

  /** AI: Lazy: the model (~30 MB, quantised) is downloaded once and cached on disk. */
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
    // AI: Batches keep memory flat when ingesting thousands of chunks.
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
