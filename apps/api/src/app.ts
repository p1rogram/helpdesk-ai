import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AppConfig } from './config.js';
import { buildContext, type AppContext } from './context.js';
import { registerSecurity } from './plugins/security.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { kbRoutes } from './routes/kb.js';
import { operatorRoutes } from './routes/operator.js';
import { corporateAuthRoutes } from './routes/corporate-auth.js';
import { ticketRoutes } from './routes/tickets.js';

export async function buildApp(
  config: AppConfig,
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // AI: Тела запросов не логируем никогда: в них диалог пользователя (персональные данные).
      serializers: { req: (r) => ({ method: r.method, url: r.url, id: r.id }) },
      ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
    bodyLimit: config.BODY_LIMIT_BYTES,
    trustProxy: true,
    requestIdHeader: 'x-request-id',
    disableRequestLogging: config.NODE_ENV === 'production',
  });

  const ctx = await buildContext(config, app.log);
  ctx.app = app;
  await registerSecurity(
    app,
    config,
    ctx.dbHandle.kind === 'postgres' ? { counters: ctx.counters } : undefined,
  );

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({ error: 'bad_request', issues: err.issues });
    if (err.statusCode === 429 || err.code === 'FST_ERR_RATE_LIMIT') {
      return reply
        .code(429)
        .send({ error: 'too_many_requests', message: 'Слишком много запросов. Подождите минуту.' });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', requestId: req.id });
  });

  await healthRoutes(app, ctx);
  await authRoutes(app, ctx);
  await corporateAuthRoutes(app, ctx);
  await app.register(async (s) => ticketRoutes(s, ctx));
  await app.register(async (s) => kbRoutes(s, ctx));
  await app.register(async (s) => adminRoutes(s, ctx));
  await app.register(async (s) => operatorRoutes(s, ctx));

  app.addHook('onClose', async () => ctx.close());
  return { app, ctx };
}
