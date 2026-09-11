import type { Category, KbArticle, Scope } from '@helpdesk/shared';
import { CatalogRepository, type LoadedCatalog } from './repository.js';
import { KnowledgeIndex, type ScoredArticle } from './search.js';

export { CatalogRepository, type LoadedCatalog } from './repository.js';
export { KnowledgeIndex, tokenize, type ScoredArticle } from './search.js';

/** AI: Facade used by the dialog engine: catalog + search index, cached per tenant version. */
export class KnowledgeService {
  private readonly indexes = new Map<string, { version: number; index: KnowledgeIndex }>();
  private readonly guestCatalogs = new Map<string, LoadedCatalog>();

  constructor(private readonly repo: CatalogRepository) {}

  /**
   * AI: Catalog as this session may see it. A guest (no organisation login) gets only the public
   * part - admission, contacts, addresses - so the assistant never offers internal procedures.
   */
  async catalog(tenantId: string, scope: Scope = 'full'): Promise<LoadedCatalog> {
    const full = await this.repo.get(tenantId);
    if (!full) throw new Error(`unknown tenant "${tenantId}"`);
    if (scope === 'full') return full;

    const cached = this.guestCatalogs.get(tenantId);
    if (cached && cached.version === full.version) return cached;

    const articles = full.articles.filter((a) => a.audience === 'public');
    const withArticles = new Set(articles.map((a) => a.categoryId));
    const categories = full.categories.filter((c) => withArticles.has(c.id));
    const guest: LoadedCatalog = {
      ...full,
      scope: 'guest',
      categories,
      articles,
      categoryById: new Map(categories.map((c) => [c.id, c])),
      articleById: new Map(articles.map((a) => [a.id, a])),
    };
    this.guestCatalogs.set(tenantId, guest);
    return guest;
  }

  async category(
    tenantId: string,
    categoryId: string,
    scope: Scope = 'full',
  ): Promise<Category | undefined> {
    return (await this.catalog(tenantId, scope)).categoryById.get(categoryId);
  }

  async article(
    tenantId: string,
    articleId: string,
    scope: Scope = 'full',
  ): Promise<KbArticle | undefined> {
    return (await this.catalog(tenantId, scope)).articleById.get(articleId);
  }

  async search(
    tenantId: string,
    query: string,
    opts: { categoryId?: string; limit?: number; exclude?: Set<string>; scope?: Scope } = {},
  ): Promise<ScoredArticle[]> {
    const scope = opts.scope ?? 'full';
    const c = await this.catalog(tenantId, scope);
    const key = `${tenantId}:${scope}`;
    let entry = this.indexes.get(key);
    if (!entry || entry.version !== c.version) {
      entry = { version: c.version, index: new KnowledgeIndex(c.articles) };
      this.indexes.set(key, entry);
    }
    return entry.index.search(query, opts);
  }
}
