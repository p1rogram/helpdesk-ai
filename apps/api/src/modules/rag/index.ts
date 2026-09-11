import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { ragChunks } from '../../db/schema.js';
import { tokenize } from '../knowledge/search.js';
import { chunkText, stripBoilerplate } from './chunker.js';
import { cosine, type Embedder } from './embedder.js';

export { chunkText } from './chunker.js';
export { LocalEmbedder, NullEmbedder, type Embedder } from './embedder.js';

/**
 * AI: Retrieval-augmented generation over crawled documentation (help.tpu.ru articles, tpu.ru
 * pages). The curated catalog answers the frequent problems with vetted steps; RAG covers the long
 * tail - "как получить справку", "кто проректор по образованию", "график приёма ректора".
 *
 * Retrieval is hybrid: BM25 over the chunk text (exact identifiers: "ЛК", "SOGo", "Вершинина 37")
 * fused with dense cosine similarity (paraphrases: "не могу зайти" ~ "ошибка входа") via
 * reciprocal-rank fusion. Either half alone still works - without an embedder it is plain BM25.
 */
export interface SourceDoc {
  url: string;
  title: string;
  text: string;
  audience: 'public' | 'internal';
}

export interface Passage {
  id: string;
  url: string;
  title: string;
  section: string;
  content: string;
  /** AI: Fused score in (0, ~0.07]; used only for ordering and a relevance floor. */
  score: number;
  lexical: number;
  dense: number;
}

interface IndexedChunk {
  id: string;
  url: string;
  title: string;
  section: string;
  content: string;
  audience: string;
  tf: Map<string, number>;
  len: number;
  embedding: number[] | null;
}

interface TenantIndex {
  chunks: IndexedChunk[];
  df: Map<string, number>;
  avgLen: number;
}

const RRF_K = 60;
/** AI: A chunk found only by the dense ranker must be a close paraphrase to count. */
const DENSE_FLOOR = 0.8;

export class RagService {
  private readonly indexes = new Map<string, TenantIndex>();

  constructor(
    private readonly db: Db,
    private readonly embedder: Embedder,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
  ) {}

  get embeddingModel(): string {
    return this.embedder.model;
  }

  // ---------- ingest ----------

  /**
   * AI: Reads the corpus from a directory. Three sources: help-tpu.json (portal articles, internal),
   * *.jsonl (one public web page per line - crawler output) and docs/*.md - hand-prepared documents
   * (regulations, orders) with a front-matter block: title, source, audience.
   */
  async loadRawDir(dir: string): Promise<SourceDoc[]> {
    const docs: SourceDoc[] = [];
    const tryRead = async (f: string) => {
      try {
        return await readFile(path.join(dir, f), 'utf8');
      } catch {
        return null;
      }
    };
    const help = await tryRead('help-tpu.json');
    if (help) {
      const parsed = JSON.parse(help) as {
        articles?: {
          url: string;
          title: string;
          body: string;
          services?: string;
          categories?: string;
        }[];
      };
      for (const a of parsed.articles ?? []) {
        if (!a.body?.trim()) continue;
        const header = [a.services, a.categories].filter(Boolean).join(' · ');
        docs.push({
          url: a.url,
          title: a.title,
          text: (header ? header + '\n\n' : '') + a.body,
          audience: 'internal',
        });
      }
    }
    const site = await tryRead('tpu-site.jsonl');
    if (site) {
      const seen = new Set<string>();
      const pages: { url: string; title: string; text: string }[] = [];
      for (const line of site.split('\n')) {
        if (!line.trim()) continue;
        const p = JSON.parse(line) as { url: string; title: string; h1?: string; text: string };
        const key = p.url.replace(/\/+$/, '');
        if (seen.has(key) || !p.text?.trim()) continue; // the crawler stores /x and /x/ as two pages
        seen.add(key);
        pages.push({ url: p.url, title: p.h1 || p.title, text: p.text });
      }
      const cleaned = stripBoilerplate(pages.map((p) => p.text));
      pages.forEach((p, i) =>
        docs.push({ url: p.url, title: p.title, text: cleaned[i]!, audience: 'public' }),
      );
    }
    let mdFiles: string[] = [];
    try {
      mdFiles = (await readdir(path.join(dir, 'docs'))).filter((f) => f.endsWith('.md'));
    } catch {
      /* no docs/ directory */
    }
    for (const f of mdFiles.sort()) {
      const doc = parseMarkdownDoc(await readFile(path.join(dir, 'docs', f), 'utf8'), f);
      if (doc) docs.push(doc);
    }
    return docs;
  }

  /** AI: Idempotent: unchanged chunks keep their vector, removed pages disappear, new text is embedded. */
  async ingest(tenantId: string, docs: SourceDoc[]): Promise<{ chunks: number; embedded: number }> {
    const existing = await this.db.select().from(ragChunks).where(eq(ragChunks.tenantId, tenantId));
    const byId = new Map(existing.map((r) => [r.id, r]));
    const keep = new Set<string>();
    const pending: { id: string; text: string }[] = [];
    let total = 0;

    type Row = typeof ragChunks.$inferInsert;
    const rows: Row[] = [];
    for (const doc of docs) {
      const parts = chunkText(doc.text);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const id = sha1(`${tenantId}|${doc.url}|${i}`).slice(0, 24);
        const hash = sha1(part.content);
        keep.add(id);
        total++;
        const prev = byId.get(id);
        const fresh =
          !prev || prev.contentHash !== hash || prev.embeddingModel !== this.embedder.model;
        rows.push({
          id,
          tenantId,
          sourceUrl: doc.url,
          title: doc.title,
          section: part.section,
          content: part.content,
          audience: doc.audience,
          contentHash: hash,
          embedding: fresh ? null : (prev?.embedding ?? null),
          embeddingModel: fresh ? null : (prev?.embeddingModel ?? null),
          updatedAt: new Date(),
        });
        if (fresh)
          pending.push({
            id,
            text: `${doc.title}. ${part.section ? part.section + '. ' : ''}${part.content}`,
          });
      }
    }
    // AI: Batched upserts - one round-trip per 50 chunks instead of one per chunk.
    for (let i = 0; i < rows.length; i += 50) {
      await this.db
        .insert(ragChunks)
        .values(rows.slice(i, i + 50))
        .onConflictDoUpdate({
          target: ragChunks.id,
          set: {
            sourceUrl: sql`excluded.source_url`,
            title: sql`excluded.title`,
            section: sql`excluded.section`,
            content: sql`excluded.content`,
            audience: sql`excluded.audience`,
            contentHash: sql`excluded.content_hash`,
            embedding: sql`excluded.embedding`,
            embeddingModel: sql`excluded.embedding_model`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
    const stale = existing.filter((r) => !keep.has(r.id)).map((r) => r.id);
    if (stale.length) await this.db.delete(ragChunks).where(inArray(ragChunks.id, stale));

    let embedded = 0;
    if (this.embedder.dims > 0 && pending.length) {
      try {
        for (let i = 0; i < pending.length; i += 64) {
          const batch = pending.slice(i, i + 64);
          const vectors = await this.embedder.embed(
            batch.map((b) => b.text),
            'passage',
          );
          await Promise.all(
            batch.map((b, j) =>
              this.db
                .update(ragChunks)
                .set({ embedding: vectors[j], embeddingModel: this.embedder.model })
                .where(and(eq(ragChunks.id, b.id), eq(ragChunks.tenantId, tenantId))),
            ),
          );
          embedded += batch.length;
        }
      } catch (err) {
        this.log.warn(`embeddings unavailable, RAG stays lexical: ${(err as Error).message}`);
      }
    }
    this.indexes.delete(tenantId);
    await this.index(tenantId);
    return { chunks: total, embedded };
  }

  // ---------- retrieval ----------

  private async index(tenantId: string): Promise<TenantIndex> {
    const cached = this.indexes.get(tenantId);
    if (cached) return cached;
    const rows = await this.db.select().from(ragChunks).where(eq(ragChunks.tenantId, tenantId));
    const df = new Map<string, number>();
    const chunks: IndexedChunk[] = rows.map((r) => {
      const tf = new Map<string, number>();
      let len = 0;
      const add = (text: string, w: number) => {
        for (const t of tokenize(text)) {
          tf.set(t, (tf.get(t) ?? 0) + w);
          len += w;
        }
      };
      add(r.title, 2);
      add(r.section, 1.5);
      add(r.content, 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      return {
        id: r.id,
        url: r.sourceUrl,
        title: r.title,
        section: r.section,
        content: r.content,
        audience: r.audience,
        tf,
        len,
        embedding: r.embedding ?? null,
      };
    });
    const idx: TenantIndex = {
      chunks,
      df,
      avgLen: chunks.reduce((s, c) => s + c.len, 0) / Math.max(1, chunks.length),
    };
    this.indexes.set(tenantId, idx);
    return idx;
  }

  async size(tenantId: string): Promise<{ chunks: number; embedded: number }> {
    const idx = await this.index(tenantId);
    return { chunks: idx.chunks.length, embedded: idx.chunks.filter((c) => c.embedding).length };
  }

  async search(
    tenantId: string,
    query: string,
    opts: { scope?: 'guest' | 'full'; limit?: number } = {},
  ): Promise<Passage[]> {
    const idx = await this.index(tenantId);
    if (!idx.chunks.length) return [];
    const visible =
      opts.scope === 'guest' ? idx.chunks.filter((c) => c.audience === 'public') : idx.chunks;
    const limit = opts.limit ?? 5;

    const lexical = this.bm25(idx, visible, query);
    let dense: { chunk: IndexedChunk; score: number }[] = [];
    if (this.embedder.dims > 0 && visible.some((c) => c.embedding)) {
      try {
        const [q] = await this.embedder.embed([query], 'query');
        if (q) {
          dense = visible
            .filter((c) => c.embedding)
            .map((chunk) => ({ chunk, score: cosine(q, chunk.embedding!) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 30);
        }
      } catch (err) {
        this.log.warn(`query embedding failed, lexical only: ${(err as Error).message}`);
      }
    }

    // AI: Reciprocal-rank fusion: a chunk in the top of both lists wins; a chunk found by only one
    // ranker still surfaces. Rank-based, so BM25 and cosine scales never need calibrating.
    const fused = new Map<string, Passage>();
    const push = (chunk: IndexedChunk, rank: number, kind: 'lexical' | 'dense', raw: number) => {
      const p = fused.get(chunk.id) ?? {
        id: chunk.id,
        url: chunk.url,
        title: chunk.title,
        section: chunk.section,
        content: chunk.content,
        score: 0,
        lexical: 0,
        dense: 0,
      };
      p.score += 1 / (RRF_K + rank);
      p[kind] = raw;
      fused.set(chunk.id, p);
    };
    lexical.forEach((h, i) => push(h.chunk, i + 1, 'lexical', h.score));
    dense.forEach((h, i) => push(h.chunk, i + 1, 'dense', h.score));

    return [...fused.values()]
      .filter((p) => p.lexical > 0 || p.dense >= DENSE_FLOOR)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private bm25(
    idx: TenantIndex,
    docs: IndexedChunk[],
    query: string,
  ): { chunk: IndexedChunk; score: number }[] {
    const q = tokenize(query, { keepShort: true });
    if (!q.length) return [];
    const terms = [...idx.df.keys()];
    const expansions = q.map((t) => ({
      exact: idx.df.has(t) ? t : null,
      prefixes: t.length >= 3 ? terms.filter((x) => x !== t && x.startsWith(t)).slice(0, 20) : [],
    }));
    const N = idx.chunks.length;
    const k1 = 1.4;
    const b = 0.75;
    const out: { chunk: IndexedChunk; score: number }[] = [];
    for (const d of docs) {
      let score = 0;
      for (const e of expansions) {
        let best = 0;
        const sc = (t: string, w: number) => {
          const f = d.tf.get(t);
          if (!f) return 0;
          const df = idx.df.get(t) ?? 0;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          return w * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / idx.avgLen)));
        };
        if (e.exact) best = sc(e.exact, 1);
        for (const p of e.prefixes) best = Math.max(best, sc(p, 0.6));
        score += best;
      }
      if (score > 0) out.push({ chunk: d, score });
    }
    return out.sort((x, y) => y.score - x.score).slice(0, 30);
  }
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/** AI: A `---` front-matter block (title, source, audience) followed by the markdown body. */
function parseMarkdownDoc(raw: string, fileName: string): SourceDoc | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.+)$/.exec(line.trim());
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  const text = m[2]!.trim();
  if (!meta.title || !text) return null;
  return {
    url: meta.source ?? `doc://${fileName}`,
    title: meta.title,
    text,
    audience: meta.audience === 'public' ? 'public' : 'internal',
  };
}
