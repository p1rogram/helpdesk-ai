import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TelegramAuthRequestSchema, type AuthResponse } from '@helpdesk/shared';
import type { AppContext } from '../context.js';
import { AuthError } from '../modules/auth/index.js';

const DevAuthSchema = z.object({ name: z.string().min(1).max(64) });
const TenantQuery = z.object({ tenant: z.string().regex(/^[a-z0-9-]{2,32}$/).optional() });

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /** Telegram Mini App: the client posts window.Telegram.WebApp.initData; we verify the HMAC. */
  app.post('/api/auth/telegram', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const verifier = ctx.verifiers.get('telegram');
    if (!verifier) return reply.code(503).send({ error: 'telegram_auth_disabled' });
    const body = TelegramAuthRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
    const { tenant } = TenantQuery.parse(req.query ?? {});
    try {
      const id = await verifier.verify(body.data.initData);
      return issue(app, ctx, id, tenant);
    } catch (err) {
      if (err instanceof AuthError) return reply.code(401).send({ error: 'invalid_init_data' });
      throw err;
    }
  });

  /** Guest login for browser demos. Only mounted when AUTH_DEV_BYPASS=true (refused in production). */
  if (ctx.verifiers.has('web')) {
    app.post('/api/auth/dev', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const body = DevAuthSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_request' });
      const { tenant } = TenantQuery.parse(req.query ?? {});
      const id = await ctx.verifiers.get('web')!.verify(body.data.name);
      return issue(app, ctx, id, tenant);
    });
  }

  app.get('/api/me', { preHandler: [app.authenticate] }, async (req) => ({
    id: req.user.sub,
    platform: req.user.platform,
    displayName: req.user.name,
    tenant: req.user.tenant,
  }));
}

async function issue(
  app: FastifyInstance,
  ctx: AppContext,
  id: { platform: 'telegram' | 'vk' | 'max' | 'web'; platformUserId: string; displayName: string },
  tenant?: string,
): Promise<AuthResponse> {
  const tenantId = tenant ?? ctx.config.DEFAULT_TENANT;
  await ctx.knowledge.catalog(tenantId); // throws on unknown tenant
  const user = await ctx.tickets.upsertUser(id.platform, id.platformUserId, id.displayName);
  const token = app.jwt.sign({
    sub: user.id,
    platform: id.platform,
    puid: id.platformUserId,
    name: id.displayName,
    tenant: tenantId,
  });
  return { token, user: { id: user.id, platform: id.platform, displayName: id.displayName } };
}
