import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/health', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    db: ctx.dbHandle.kind,
    events: ctx.config.EVENT_BUS,
    llm: ctx.llm.enabled,
    uptime: Math.round(process.uptime()),
  }));

  /** Public tenant info for the client bootstrap (no auth: only non-sensitive data). */
  app.get('/api/tenants', async () => ({
    tenants: await ctx.catalogs.listTenants(),
    default: ctx.config.DEFAULT_TENANT,
    botUrl: ctx.config.TELEGRAM_BOT_USERNAME ? `https://t.me/${ctx.config.TELEGRAM_BOT_USERNAME}` : undefined,
  }));
}
