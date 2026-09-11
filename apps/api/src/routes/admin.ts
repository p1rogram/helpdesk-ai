import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { KbArticleSchema } from '@helpdesk/shared';
import type { AppContext } from '../context.js';

/**
 * AI: Администрирование каталога. Сменить сферу = импортировать сюда JSON каталога - без деплоя и
 * правки файлов на сервере. Только для ADMIN_USERS.
 */
export async function adminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addHook('preHandler', app.requireAdmin);

  app.get('/api/admin/tenants', async () => ({ tenants: await ctx.catalogs.listTenants() }));

  app.get('/api/admin/tenants/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const c = await ctx.catalogs.get(id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    return {
      id: c.id,
      sphere: c.sphere,
      organisation: c.organisation,
      language: c.language,
      version: c.version,
      categories: c.categories,
      articles: c.articles,
    };
  });

  /** AI: Полный импорт / замена каталога тенанта (тело = JSON каталога). */
  app.post('/api/admin/catalog/import', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    try {
      const loaded = await ctx.catalogs.upsert(req.body);
      return {
        id: loaded.id,
        version: loaded.version,
        categories: loaded.categories.length,
        articles: loaded.articles.length,
      };
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_catalog', message: (err as Error).message });
    }
  });

  app.put('/api/admin/tenants/:id/articles/:articleId', async (req, reply) => {
    const p = z.object({ id: z.string(), articleId: z.string() }).parse(req.params);
    const body = KbArticleSchema.safeParse({ ...(req.body as object), id: p.articleId });
    if (!body.success)
      return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
    const catalog = await ctx.catalogs.get(p.id);
    if (!catalog) return reply.code(404).send({ error: 'not_found' });
    if (!catalog.categoryById.has(body.data.categoryId))
      return reply.code(400).send({ error: 'unknown_category' });
    await ctx.catalogs.upsertArticle(p.id, body.data);
    return { ok: true };
  });

  /** AI: Состояние корпуса RAG: сколько фрагментов проиндексировано и у скольких есть вектор. */
  app.get('/api/admin/rag/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return {
      tenant: id,
      embeddings: ctx.rag.embeddingModel,
      dense: ctx.rag.denseBackend,
      ...(await ctx.rag.size(id)),
    };
  });

  /**
   * AI: Переиндексировать скачанную документацию. Тело: `{ tenant?, dir? }` - читает вывод краулера
   * на сервере (по умолчанию `RAG_RAW_DIR`) или принимает документы напрямую: `{ tenant, docs:
   * [{url,title,text,audience}] }`.
   */
  app.post('/api/admin/rag/ingest', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const body = z
      .object({
        tenant: z.string().default(ctx.config.DEFAULT_TENANT),
        docs: z
          .array(
            z.object({
              url: z.string().url(),
              title: z.string().min(1),
              text: z.string().min(1),
              audience: z.enum(['public', 'internal']).default('internal'),
            }),
          )
          .optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success)
      return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
    const started = Date.now();
    const docs = body.data.docs ?? (await ctx.rag.loadRawDir(ctx.config.RAG_RAW_DIR));
    const res = await ctx.rag.ingest(body.data.tenant, docs);
    return { tenant: body.data.tenant, documents: docs.length, ...res, ms: Date.now() - started };
  });

  app.delete('/api/admin/tenants/:id/articles/:articleId', async (req) => {
    const p = z.object({ id: z.string(), articleId: z.string() }).parse(req.params);
    await ctx.catalogs.deleteArticle(p.id, p.articleId);
    return { ok: true };
  });
}
