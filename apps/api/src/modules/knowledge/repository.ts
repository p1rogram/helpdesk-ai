import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  CatalogSchema,
  type Catalog,
  type Category,
  type KbArticle,
  type Scope,
} from '@helpdesk/shared';
import type { Db } from '../../db/client.js';
import { categories, kbArticles, tenants } from '../../db/schema.js';

export interface LoadedCatalog extends Catalog {
  version: number;
  /** AI: Для какой аудитории отфильтровано это представление (guest = только публичные статьи). */
  scope: Scope;
  categoryById: Map<string, Category>;
  articleById: Map<string, KbArticle>;
}

/**
 * AI: Каталог живёт в базе (редактируется через admin API в рантайме); этот репозиторий держит
 * копию в памяти на тенант, привязанную к `tenants.version`, чтобы горячий путь не трогал БД.
 * Изменение каталога поднимает версию -> кэш обновляется при следующем чтении.
 */
export class CatalogRepository {
  private readonly cache = new Map<string, LoadedCatalog>();

  constructor(private readonly db: Db) {}

  async listTenants(): Promise<Array<{ id: string; sphere: string; version: number }>> {
    return this.db
      .select({ id: tenants.id, sphere: tenants.sphere, version: tenants.version })
      .from(tenants)
      .orderBy(asc(tenants.id));
  }

  async get(tenantId: string): Promise<LoadedCatalog | null> {
    const [t] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!t) return null;
    const cached = this.cache.get(tenantId);
    if (cached && cached.version === t.version) return cached;

    const cats = await this.db
      .select()
      .from(categories)
      .where(eq(categories.tenantId, tenantId))
      .orderBy(asc(categories.sortOrder));
    const arts = await this.db.select().from(kbArticles).where(eq(kbArticles.tenantId, tenantId));

    const catalog: Catalog = {
      id: t.id,
      sphere: t.sphere,
      organisation: t.organisation,
      language: t.language,
      categories: cats.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        priority: c.priority as Category['priority'],
        escalation: (c.escalation ?? 'operator') as Category['escalation'],
        clarify: c.clarify,
      })),
      articles: arts.map((a) => ({
        id: a.id,
        categoryId: a.categoryId,
        title: a.title,
        symptoms: a.symptoms,
        steps: a.steps,
        notApplicableWhen: a.notApplicableWhen ?? undefined,
        escalateAfter: a.escalateAfter,
        audience: a.audience as 'public' | 'internal',
        source: a.source ?? undefined,
      })),
    };
    const loaded: LoadedCatalog = {
      ...catalog,
      version: t.version,
      scope: 'full',
      categoryById: new Map(catalog.categories.map((c) => [c.id, c])),
      articleById: new Map(catalog.articles.map((a) => [a.id, a])),
    };
    this.cache.set(tenantId, loaded);
    return loaded;
  }

  /** AI: Полная замена каталога тенанта (импорт). Транзакционно; поднимает версию. */
  async upsert(input: unknown): Promise<LoadedCatalog> {
    const catalog = CatalogSchema.parse(input);
    validateCatalog(catalog);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(tenants)
        .values({
          id: catalog.id,
          sphere: catalog.sphere,
          organisation: catalog.organisation,
          language: catalog.language,
        })
        .onConflictDoUpdate({
          target: tenants.id,
          set: {
            sphere: catalog.sphere,
            organisation: catalog.organisation,
            language: catalog.language,
            version: sql`${tenants.version} + 1`,
            updatedAt: new Date(),
          },
        });
      await tx.delete(categories).where(eq(categories.tenantId, catalog.id));
      await tx.delete(kbArticles).where(eq(kbArticles.tenantId, catalog.id));
      await tx.insert(categories).values(
        catalog.categories.map((c, i) => ({
          tenantId: catalog.id,
          id: c.id,
          name: c.name,
          description: c.description,
          priority: c.priority,
          escalation: c.escalation,
          clarify: c.clarify,
          sortOrder: i,
        })),
      );
      await tx.insert(kbArticles).values(
        catalog.articles.map((a) => ({
          tenantId: catalog.id,
          id: a.id,
          categoryId: a.categoryId,
          title: a.title,
          symptoms: a.symptoms,
          steps: a.steps,
          notApplicableWhen: a.notApplicableWhen ?? null,
          escalateAfter: a.escalateAfter,
          audience: a.audience,
          source: a.source ?? null,
        })),
      );
    });
    this.cache.delete(catalog.id);
    return (await this.get(catalog.id))!;
  }

  /** AI: Upsert одной статьи (правка админом) - поднимает версию тенанта. */
  async upsertArticle(tenantId: string, article: KbArticle): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(kbArticles)
        .values({
          tenantId,
          ...article,
          notApplicableWhen: article.notApplicableWhen ?? null,
          source: article.source ?? null,
        })
        .onConflictDoUpdate({
          target: [kbArticles.tenantId, kbArticles.id],
          set: {
            categoryId: article.categoryId,
            title: article.title,
            symptoms: article.symptoms,
            steps: article.steps,
            notApplicableWhen: article.notApplicableWhen ?? null,
            escalateAfter: article.escalateAfter,
            audience: article.audience,
            source: article.source ?? null,
            updatedAt: new Date(),
          },
        });
      await tx
        .update(tenants)
        .set({ version: sql`${tenants.version} + 1`, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));
    });
    this.cache.delete(tenantId);
  }

  async deleteArticle(tenantId: string, articleId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(kbArticles)
        .where(and(eq(kbArticles.tenantId, tenantId), eq(kbArticles.id, articleId)));
      await tx
        .update(tenants)
        .set({ version: sql`${tenants.version} + 1`, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));
    });
    this.cache.delete(tenantId);
  }

  /**
   * AI: Импортировать каждый data/catalog/*.json, которого ещё нет в БД. Существующие тенанты не
   * трогаются.
   */
  /**
   * AI: Сид-файлы - источник истины для каталога: тенант импортируется, когда он новый или когда
   * его файл изменился с последнего импорта (хэш хранится в строке тенанта), - так правка статьи в
   * git доходит до каждого стенда при следующем старте, на каждой реплике, без ручного переимпорта.
   * `force` импортирует в любом случае.
   */
  async seedFromDir(dir: string, log: { info(msg: string): void }, force = false): Promise<void> {
    const hashes = new Map(
      (await this.db.select({ id: tenants.id, seedHash: tenants.seedHash }).from(tenants)).map(
        (t) => [t.id, t.seedHash],
      ),
    );
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    } catch {
      log.info(`catalog seed dir ${dir} not found - skipping`);
      return;
    }
    for (const f of files) {
      const text = await readFile(path.join(dir, f), 'utf8');
      const hash = createHash('sha1').update(text).digest('hex');
      const raw = JSON.parse(text) as { id?: string };
      if (!force && raw.id && hashes.has(raw.id) && hashes.get(raw.id) === hash) continue;
      const loaded = await this.upsert(raw);
      await this.db.update(tenants).set({ seedHash: hash }).where(eq(tenants.id, loaded.id));
      log.info(
        `catalog seeded: ${loaded.id} (${loaded.categories.length} categories, ${loaded.articles.length} articles)`,
      );
    }
  }
}

function validateCatalog(c: Catalog): void {
  const ids = new Set(c.categories.map((x) => x.id));
  for (const a of c.articles) {
    if (!ids.has(a.categoryId)) {
      throw new Error(`article "${a.id}" references unknown category "${a.categoryId}"`);
    }
  }
}
