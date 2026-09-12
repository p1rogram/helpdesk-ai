import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { ragChunks } from '../../db/schema.js';
import { tokenize, tokenizeQuery } from '../knowledge/search.js';
import { chunkText, stripBoilerplate } from './chunker.js';
import { cosine, type Embedder } from './embedder.js';
import { redactNames } from './redact.js';

export { chunkText } from './chunker.js';
export { LocalEmbedder, NullEmbedder, type Embedder } from './embedder.js';
export { redactNames } from './redact.js';

/**
 * AI: Генерация с поиском (RAG) по скачанной документации (статьи help.tpu.ru, страницы tpu.ru).
 * Проверенный каталог отвечает на частые проблемы выверенными шагами; RAG закрывает длинный хвост -
 * «как получить справку», «кто проректор по образованию», «график приёма ректора».
 *
 * Поиск гибридный: BM25 по тексту фрагментов (точные идентификаторы: «ЛК», «SOGo», «Вершинина 37»),
 * слитый с косинусной близостью векторов (парафразы: «не могу зайти» ~ «ошибка входа») через
 * слияние взаимных рангов. Каждая половина работает и сама по себе - без эмбеддера это обычный
 * BM25.
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
  /**
   * AI: Слитый балл в (0, ~0.07]; используется только для упорядочивания и порога релевантности.
   */
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

/**
 * AI: Индекс одного тенанта в памяти. `postings` - инвертированный индекс (терм -> фрагменты, где
 * он есть), поэтому запрос трогает только фрагменты с общим термом, а не весь корпус; `terms`
 * отсортирован для расширения префиксов бинарным поиском. `stamp` - отпечаток базы, по которому
 * индекс построен, см. index().
 */
interface TenantIndex {
  chunks: IndexedChunk[];
  byId: Map<string, IndexedChunk>;
  df: Map<string, number>;
  postings: Map<string, number[]>;
  terms: string[];
  avgLen: number;
  stamp: string;
  checkedAt: number;
}

/**
 * AI: Как долго реплика доверяет своей копии, прежде чем спросить базу, не изменился ли корпус.
 */
const STAMP_TTL_MS = 5_000;

const RRF_K = 60;
/**
 * AI: Фрагмент, найденный только векторным ранжировщиком, должен быть близким парафразом, чтобы
 * считаться.
 */
const DENSE_FLOOR = 0.8;

export class RagService {
  private readonly indexes = new Map<string, TenantIndex>();
  private readonly stampTtlMs: number;
  /** AI: Колонка pgvector + HNSW-индекс на месте; векторный поиск выполняется в базе. */
  private vectorReady = false;

  constructor(
    private readonly db: Db,
    private readonly embedder: Embedder,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
    opts: { stampTtlMs?: number } = {},
  ) {
    this.stampTtlMs = opts.stampTtlMs ?? STAMP_TTL_MS;
  }

  get embeddingModel(): string {
    return this.embedder.model;
  }

  get denseBackend(): 'pgvector' | 'memory' | 'off' {
    if (this.embedder.dims === 0) return 'off';
    return this.vectorReady ? 'pgvector' : 'memory';
  }

  /**
   * AI: Поиск ближайших соседей должен жить в базе, а не в цикле по всем строкам: с pgvector
   * векторная половина поиска - это обращение к HNSW-индексу, O(log n) вместо O(n), и индекс общий
   * для всех реплик API. JSONB-копия вектора остаётся переносимым запасным вариантом: на Postgres
   * без расширения сервис продолжает работать из памяти.
   */
  async prepareStorage(): Promise<void> {
    if (this.embedder.dims === 0) return;
    const dims = this.embedder.dims;
    try {
      await this.db.execute(sql.raw('CREATE EXTENSION IF NOT EXISTS vector'));
      await this.db.execute(
        sql.raw(`ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS embedding_vec vector(${dims})`),
      );
    } catch (err) {
      this.vectorReady = false;
      this.log.warn(
        `pgvector unavailable, dense search stays in memory: ${(err as Error).message}`,
      );
      return;
    }
    try {
      await this.db.execute(
        sql.raw(
          'CREATE INDEX IF NOT EXISTS rag_chunks_vec ON rag_chunks USING hnsw (embedding_vec vector_cosine_ops)',
        ),
      );
    } catch (err) {
      // AI: Старый pgvector без HNSW: запрос всё равно работает, последовательным сканированием.
      this.log.warn(`hnsw index not created: ${(err as Error).message}`);
    }
    // AI: Базы, заполненные до появления этой колонки: один раз переносим JSONB-векторы.
    await this.db.execute(
      sql.raw(
        'UPDATE rag_chunks SET embedding_vec = embedding::text::vector WHERE embedding IS NOT NULL AND embedding_vec IS NULL',
      ),
    );
    this.vectorReady = true;
    this.log.info('rag: dense search via pgvector (hnsw)');
  }

  // ---------- индексация ----------

  /**
   * AI: Читает корпус из каталога. Три источника: help-tpu.json (статьи портала, internal), *.jsonl
   * (одна публичная веб-страница на строку - вывод краулера) и docs/*.md - подготовленные вручную
   * документы (регламенты, приказы) с блоком front-matter: title, source, audience.
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
        const key = p.url.split('?')[0]!.replace(/\/+$/, ''); // /x, /x/ and /x?ysclid=… are one page
        if (seen.has(key) || !p.text?.trim()) continue; // the crawler stores /x and /x/ as two pages
        seen.add(key);
        pages.push({ url: key, title: p.h1 || p.title, text: p.text });
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
      /* каталога docs/ нет */
    }
    for (const f of mdFiles.sort()) {
      const doc = parseMarkdownDoc(await readFile(path.join(dir, 'docs', f), 'utf8'), f);
      if (doc) docs.push(doc);
    }
    return docs;
  }

  /**
   * AI: Идемпотентно: неизменённые фрагменты сохраняют вектор, удалённые страницы исчезают, новый
   * текст векторизуется.
   */
  async ingest(tenantId: string, docs: SourceDoc[]): Promise<{ chunks: number; embedded: number }> {
    const existing = await this.db.select().from(ragChunks).where(eq(ragChunks.tenantId, tenantId));
    const byId = new Map(existing.map((r) => [r.id, r]));
    const keep = new Set<string>();
    const pending: { id: string; text: string }[] = [];
    let total = 0;

    type Row = typeof ragChunks.$inferInsert;
    const rows: Row[] = [];
    for (const doc of docs) {
      // AI: Персональные имена никогда не попадают в индекс - см. redact.ts.
      const parts = chunkText(redactNames(doc.text));
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
    // AI: Батчевые upsert - один раунд-трип на 50 фрагментов вместо одного на фрагмент.
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
    if (this.vectorReady)
      await this.db.execute(
        sql`UPDATE rag_chunks SET embedding_vec = NULL WHERE tenant_id = ${tenantId} AND embedding IS NULL`,
      );

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
            batch.map(async (b, j) => {
              await this.db
                .update(ragChunks)
                .set({ embedding: vectors[j], embeddingModel: this.embedder.model })
                .where(and(eq(ragChunks.id, b.id), eq(ragChunks.tenantId, tenantId)));
              if (this.vectorReady)
                await this.db.execute(
                  sql`UPDATE rag_chunks SET embedding_vec = ${toVectorLiteral(vectors[j]!)}::vector WHERE id = ${b.id}`,
                );
            }),
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

  // ---------- поиск ----------

  /**
   * AI: Отпечаток корпуса (число строк + последнее изменение) - один индексированный запрос. Каждая
   * реплика сравнивает его с отпечатком своего индекса в памяти, поэтому индексация на любой
   * реплике - или через admin API - подхватывается везде в пределах STAMP_TTL_MS, без общего кэша,
   * который нужно инвалидировать.
   */
  private async stamp(tenantId: string): Promise<string> {
    const [row] = await this.db
      .select({
        n: sql<number>`count(*)`,
        t: sql<string | null>`max(${ragChunks.updatedAt})`,
      })
      .from(ragChunks)
      .where(eq(ragChunks.tenantId, tenantId));
    return `${row?.n ?? 0}|${row?.t ?? ''}`;
  }

  private async index(tenantId: string): Promise<TenantIndex> {
    const cached = this.indexes.get(tenantId);
    const now = Date.now();
    if (cached && now - cached.checkedAt < this.stampTtlMs) return cached;
    const stamp = await this.stamp(tenantId);
    if (cached && cached.stamp === stamp) {
      cached.checkedAt = now;
      return cached;
    }
    const rows = await this.db.select().from(ragChunks).where(eq(ragChunks.tenantId, tenantId));
    const df = new Map<string, number>();
    const postings = new Map<string, number[]>();
    const chunks: IndexedChunk[] = rows.map((r, i) => {
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
      for (const t of tf.keys()) {
        df.set(t, (df.get(t) ?? 0) + 1);
        const list = postings.get(t);
        if (list) list.push(i);
        else postings.set(t, [i]);
      }
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
      byId: new Map(chunks.map((c) => [c.id, c])),
      df,
      postings,
      terms: [...df.keys()].sort(),
      avgLen: chunks.reduce((s, c) => s + c.len, 0) / Math.max(1, chunks.length),
      stamp,
      checkedAt: now,
    };
    this.indexes.set(tenantId, idx);
    if (rows.length) this.log.info(`rag index built: ${tenantId}, ${rows.length} chunks`);
    return idx;
  }

  /**
   * AI: Загружает модель эмбеддингов и строит индекс до первого пользователя, чтобы за холодный
   * старт не платил первый вопрос.
   */
  async warmup(tenantId: string): Promise<void> {
    try {
      await this.index(tenantId);
      if (this.embedder.dims > 0) await this.embedder.embed(['прогрев'], 'query');
    } catch (err) {
      this.log.warn(`rag warmup failed: ${(err as Error).message}`);
    }
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

    const lexical = this.bm25(idx, opts.scope === 'guest' ? 'public' : null, query);
    let dense: { chunk: IndexedChunk; score: number }[] = [];
    if (this.embedder.dims > 0 && visible.some((c) => c.embedding)) {
      try {
        const [q] = await this.embedder.embed([query], 'query');
        if (q && this.vectorReady) {
          dense = await this.denseInDb(idx, tenantId, q, opts.scope === 'guest' ? 'public' : null);
        } else if (q) {
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

    // AI: Слияние взаимных рангов (RRF): фрагмент в топе обоих списков побеждает; фрагмент,
    // найденный только одним ранжировщиком, всё равно всплывает. По рангам, поэтому шкалы BM25 и
    // косинуса не нужно калибровать.
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

  /**
   * AI: Топ-30 по косинусной близости через HNSW-индекс; `<=>` в pgvector - косинусное расстояние.
   */
  private async denseInDb(
    idx: TenantIndex,
    tenantId: string,
    q: number[],
    audience: string | null,
  ): Promise<{ chunk: IndexedChunk; score: number }[]> {
    const lit = toVectorLiteral(q);
    const res = await this.db.execute(
      sql`SELECT id, 1 - (embedding_vec <=> ${lit}::vector) AS score
          FROM rag_chunks
          WHERE tenant_id = ${tenantId} AND embedding_vec IS NOT NULL
            AND (${audience}::text IS NULL OR audience = ${audience}::text)
          ORDER BY embedding_vec <=> ${lit}::vector
          LIMIT 30`,
    );
    const rows = (res as unknown as { rows: Array<{ id: string; score: number | string }> }).rows;
    const out: { chunk: IndexedChunk; score: number }[] = [];
    for (const r of rows) {
      const chunk = idx.byId.get(r.id);
      if (chunk) out.push({ chunk, score: Number(r.score) });
    }
    return out;
  }

  /**
   * AI: BM25 по инвертированному индексу: для каждого терма запроса (и до 20 его префиксных
   * расширений, найденных бинарным поиском в отсортированном списке термов) обходится только список
   * вхождений. Стоимость растёт с числом фрагментов, имеющих общий терм с запросом, а не с размером
   * корпуса.
   */
  private bm25(
    idx: TenantIndex,
    audience: string | null,
    query: string,
  ): { chunk: IndexedChunk; score: number }[] {
    // AI: Опечатки: терм, которого нет в индексе, заменяется ближайшим известным (одна правка).
    const q = tokenizeQuery(
      query,
      (st) => idx.df.has(st) || (st.length >= 3 && prefixMatches(idx.terms, st, 1).length > 0),
    );
    if (!q.length) return [];
    const N = idx.chunks.length;
    const k1 = 1.4;
    const b = 0.75;
    const scores = new Map<number, number>();
    for (const term of q) {
      const candidates: Array<[string, number]> = [];
      if (idx.df.has(term)) candidates.push([term, 1]);
      if (term.length >= 3)
        for (const p of prefixMatches(idx.terms, term, 20)) candidates.push([p, 0.6]);
      // AI: Фрагмент получает лучшее из «точный терм» и «префиксный вариант» для этого терма
      // запроса, один раз.
      const best = new Map<number, number>();
      for (const [t, w] of candidates) {
        const df = idx.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        for (const i of idx.postings.get(t) ?? []) {
          const d = idx.chunks[i]!;
          if (audience && d.audience !== audience) continue;
          const f = d.tf.get(t)!;
          const sc = w * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / idx.avgLen)));
          if (sc > (best.get(i) ?? 0)) best.set(i, sc);
        }
      }
      for (const [i, sc] of best) scores.set(i, (scores.get(i) ?? 0) + sc);
    }
    return [...scores.entries()]
      .map(([i, score]) => ({ chunk: idx.chunks[i]!, score }))
      .sort((x, y) => y.score - x.score)
      .slice(0, 30);
  }
}

/**
 * AI: Термы, начинающиеся с `prefix` (кроме самого префикса), из отсортированного списка, не больше
 * `limit`.
 */
function prefixMatches(sorted: string[], prefix: string, limit: number): string[] {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out: string[] = [];
  for (let i = lo; i < sorted.length && out.length < limit; i++) {
    const t = sorted[i]!;
    if (!t.startsWith(prefix)) break;
    if (t !== prefix) out.push(t);
  }
  return out;
}

/**
 * AI: Текстовый ввод pgvector: "[0.1,0.2,...]". Шесть знаков после запятой делают литерал коротким;
 * на косинус не влияет.
 */
function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => x.toFixed(6)).join(',')}]`;
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/** AI: Блок front-matter `---` (title, source, audience), за которым идёт тело markdown. */
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
