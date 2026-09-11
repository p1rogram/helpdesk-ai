import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DocPassage, KbSearchResult } from '@helpdesk/shared';
import type { AppContext } from '../context.js';

const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  category: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

/** AI: Публичная (после входа) база знаний: категории и поиск - «поиск по базе знаний». */
export async function kbRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/kb/categories', async (req) => {
    const catalog = await ctx.knowledge.catalog(req.user.tenant, req.user.scope ?? 'full');
    return {
      tenant: { id: catalog.id, sphere: catalog.sphere },
      categories: catalog.categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
      })),
    };
  });

  app.get('/api/kb/search', async (req, reply) => {
    const q = SearchQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request', issues: q.error.issues });
    const hits = await ctx.knowledge.search(req.user.tenant, q.data.q, {
      categoryId: q.data.category,
      limit: q.data.limit,
      scope: req.user.scope ?? 'full',
    });
    const results: KbSearchResult[] = hits.map((h) => ({
      id: h.article.id,
      categoryId: h.article.categoryId,
      title: h.article.title,
      steps: h.article.steps,
      score: Math.round(h.score * 100) / 100,
    }));
    // AI: Фрагменты документации (RAG) дополняют проверенные статьи; гости видят только публичные
    // страницы.
    const passages = ctx.config.RAG_ENABLED
      ? await ctx.rag.search(req.user.tenant, q.data.q, {
          scope: req.user.scope ?? 'full',
          limit: 5,
        })
      : [];
    const docs: DocPassage[] = passages.map((p) => ({
      id: p.id,
      url: p.url,
      title: p.title,
      section: p.section,
      snippet: p.content.length > 280 ? p.content.slice(0, 277).trimEnd() + '…' : p.content,
    }));
    return { results, docs };
  });

  app.get('/api/kb/articles/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().max(128) }).parse(req.params);
    const article = await ctx.knowledge.article(req.user.tenant, id, req.user.scope ?? 'full');
    if (!article) return reply.code(404).send({ error: 'not_found' });
    return { article };
  });
}
