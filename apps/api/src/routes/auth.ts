import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { TelegramAuthRequestSchema, type AuthResponse, type Platform } from '@helpdesk/shared';
import type { AppContext } from '../context.js';
import { AuthError, pseudonym } from '../modules/auth/index.js';

const DevAuthSchema = z.object({
  name: z.string().min(1).max(64),
  /** AI: На сайте два входа: гость (только публичные вопросы) и пользователь организации. */
  scope: z.enum(['guest', 'full']).default('full'),
  /** AI: Ответ Cloudflare Turnstile; обязателен для гостя, если проверка включена. */
  turnstileToken: z.string().max(4096).optional(),
});

const DEVICE_COOKIE = 'hd_device';

/**
 * AI: Cookie устройства гостя: случайный id, подписанный секретом сервера, срок - год. Ключ
 * гостевого бюджета модели: новая сессия - тот же счётчик. Персональных данных не содержит.
 */
function ensureDevice(req: FastifyRequest, reply: FastifyReply): string {
  const raw = req.cookies[DEVICE_COOKIE];
  if (raw) {
    const r = req.unsignCookie(raw);
    if (r.valid && r.value && /^[a-f0-9]{32}$/.test(r.value)) return r.value;
  }
  const id = randomBytes(16).toString('hex');
  reply.setCookie(DEVICE_COOKIE, id, {
    path: '/api',
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    signed: true,
    maxAge: 365 * 24 * 3600,
  });
  return id;
}

/** AI: Проверка Turnstile на сервере: без валидного ответа гостевая сессия не выдаётся. */
async function verifyTurnstile(secret: string, token: string | undefined, ip: string) {
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
const TenantQuery = z.object({
  tenant: z
    .string()
    .regex(/^[a-z0-9-]{2,32}$/)
    .optional(),
});

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /**
   * AI: Telegram Mini App: клиент присылает window.Telegram.WebApp.initData; мы проверяем HMAC.
   */
  app.post(
    '/api/auth/telegram',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const verifier = ctx.verifiers.get('telegram');
      if (!verifier) return reply.code(503).send({ error: 'telegram_auth_disabled' });
      const body = TelegramAuthRequestSchema.safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
      const { tenant } = TenantQuery.parse(req.query ?? {});
      try {
        const id = await verifier.verify(body.data.initData);
        return issue(app, ctx, id, tenant);
      } catch (err) {
        if (err instanceof AuthError) return reply.code(401).send({ error: 'invalid_init_data' });
        throw err;
      }
    },
  );

  /**
   * AI: VK / MAX Mini Apps используют тот же контракт, что Telegram: клиент присылает непрозрачный
   * подписанный payload от хост-приложения, соответствующий PlatformVerifier проверяет его,
   * выдаётся JWT сессии.
   */
  for (const platform of ['vk', 'max'] as const) {
    app.post(
      `/api/auth/${platform}`,
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const verifier = ctx.verifiers.get(platform);
        if (!verifier) return reply.code(503).send({ error: `${platform}_auth_disabled` });
        const body = z.object({ payload: z.string().min(1).max(8192) }).safeParse(req.body);
        if (!body.success)
          return reply.code(400).send({ error: 'bad_request', issues: body.error.issues });
        const { tenant } = TenantQuery.parse(req.query ?? {});
        try {
          const id = await verifier.verify(body.data.payload);
          return issue(app, ctx, id, tenant);
        } catch (err) {
          if (err instanceof AuthError) return reply.code(401).send({ error: 'invalid_payload' });
          throw err;
        }
      },
    );
  }

  /** AI: Вход на сайте без провайдера идентификации: гость (публичные темы) или демо-студент. */
  if (ctx.verifiers.has('web')) {
    app.post(
      '/api/auth/dev',
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const body = DevAuthSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'bad_request' });
        const { tenant } = TenantQuery.parse(req.query ?? {});
        const allowed =
          body.data.scope === 'guest' ? ctx.config.WEB_GUEST_LOGIN : ctx.config.WEB_DEMO_LOGIN;
        if (!allowed) return reply.code(403).send({ error: 'login_disabled' });
        if (body.data.scope === 'guest') {
          if (
            ctx.config.TURNSTILE_SECRET &&
            !(await verifyTurnstile(ctx.config.TURNSTILE_SECRET, body.data.turnstileToken, req.ip))
          )
            return reply.code(403).send({ error: 'captcha_required' });
          // AI: Гость - это устройство, а не имя: имя не хранится, личность - cookie.
          const device = ensureDevice(req, reply);
          return issue(
            app,
            ctx,
            { platform: 'web', platformUserId: device, displayName: pseudonym('web', device) },
            tenant,
            'guest',
            device,
          );
        }
        const id = await ctx.verifiers.get('web')!.verify(body.data.name);
        return issue(app, ctx, id, tenant, body.data.scope);
      },
    );
  }

  app.get('/api/me', { preHandler: [app.authenticate] }, async (req) => ({
    id: req.user.sub,
    platform: req.user.platform,
    displayName: req.user.name,
    tenant: req.user.tenant,
    scope: req.user.scope ?? 'full',
    isAdmin:
      req.user.scope !== 'guest' &&
      (ctx.config.OPERATOR_OPEN_ACCESS ||
        ctx.config.adminUsers.has(`${req.user.platform}:${req.user.puid}`) ||
        (req.user.roles?.includes('operator') ?? false)),
  }));
}

async function issue(
  app: FastifyInstance,
  ctx: AppContext,
  id: { platform: Platform; platformUserId: string; displayName: string },
  tenant?: string,
  scope: 'guest' | 'full' = 'full',
  device?: string,
): Promise<AuthResponse> {
  const tenantId = tenant ?? ctx.config.DEFAULT_TENANT;
  await ctx.knowledge.catalog(tenantId); // throws on unknown tenant
  const puid = scope === 'guest' ? `guest:${id.platformUserId}` : id.platformUserId;
  const user = await ctx.tickets.upsertUser(id.platform, puid, id.displayName);
  const token = app.jwt.sign(
    {
      sub: user.id,
      platform: id.platform,
      puid,
      name: id.displayName,
      tenant: tenantId,
      scope,
      ...(device ? { device } : {}),
    },
    // AI: Гостевой токен живёт меньше: утёкший токен быстро становится бесполезным.
    scope === 'guest' ? { expiresIn: ctx.config.GUEST_JWT_TTL } : {},
  );
  return {
    token,
    user: { id: user.id, platform: id.platform, displayName: id.displayName, scope },
  };
}
