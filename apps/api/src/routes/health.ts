import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/health', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    db: ctx.dbHandle.kind,
    events: ctx.config.EVENT_BUS,
    llm: ctx.llm.enabled,
    /** AI: anthropic (облако) или openai (локальный сервер модели). */
    llmProvider: ctx.llm.provider,
    /** AI: off | memory | pgvector - где выполняется векторная половина поиска. */
    rag: ctx.config.RAG_ENABLED ? ctx.rag.denseBackend : 'disabled',
    /** AI: Ступень суточного потолка модели: ok | guests_off | all_off. */
    llmBudget: (await ctx.budget.snapshot()).stage,
    uptime: Math.round(process.uptime()),
  }));

  /**
   * AI: Публичная информация о тенанте для загрузки клиента (без авторизации: только
   * нечувствительные данные).
   */
  app.get('/api/tenants', async () => ({
    tenants: await ctx.catalogs.listTenants(),
    default: ctx.config.DEFAULT_TENANT,
    botUrl: ctx.config.TELEGRAM_BOT_USERNAME
      ? `https://t.me/${ctx.config.TELEGRAM_BOT_USERNAME}`
      : undefined,
  }));
}
