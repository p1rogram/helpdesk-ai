import type { Category, KbArticle } from '@helpdesk/shared';
import { CatalogRepository, type LoadedCatalog } from './repository.js';
import { KnowledgeIndex, type ScoredArticle } from './search.js';

export { CatalogRepository, type LoadedCatalog } from './repository.js';
export { KnowledgeIndex, tokenize, type ScoredArticle } from './search.js';

/** Facade used by the dialog engine: catalog + search index, cached per tenant version. */
export class KnowledgeService {
  private readonly indexes = new Map<string, { version: number; index: KnowledgeIndex }>();

  constructor(private readonly repo: CatalogRepository) {}

  async catalog(tenantId: string): Promise<LoadedCatalog> {
    const c = await this.repo.get(tenantId);
    if (!c) throw new Error(`unknown tenant "${tenantId}"`);
    return c;
  }

  async category(tenantId: string, categoryId: string): Promise<Category | undefined> {
    return (await this.catalog(tenantId)).categoryById.get(categoryId);
  }

  async article(tenantId: string, articleId: string): Promise<KbArticle | undefined> {
    return (await this.catalog(tenantId)).articleById.get(articleId);
  }

  async search(
    tenantId: string,
    query: string,
    opts: { categoryId?: string; limit?: number; exclude?: Set<string> } = {},
  ): Promise<ScoredArticle[]> {
    const c = await this.catalog(tenantId);
    let entry = this.indexes.get(tenantId);
    if (!entry || entry.version !== c.version) {
      entry = { version: c.version, index: new KnowledgeIndex(c.articles) };
      this.indexes.set(tenantId, entry);
    }
    return entry.index.search(query, opts);
  }
}
