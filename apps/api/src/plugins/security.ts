import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { SessionClaims } from '../modules/auth/index.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: SessionClaims;
    user: SessionClaims;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** AI: Консоль оператора: ADMIN_USERS, группы операторов или все в демо-режиме. */
    requireOperator: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * AI: Администрирование (каталог, RAG): только ADMIN_USERS - демо-режим этого никогда не
     * открывает.
     */
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * AI: Защита периметра в одном месте:
 *  - helmet: заголовки безопасности (CSP задаёт собственный сервер веб-приложения; API отдаёт только JSON)
 *  - cors: белый список origin (origin Mini App + локальная разработка)
 *  - rate-limit: на аутентифицированного пользователя, иначе по IP - защищает бюджет модели
 *  - jwt: короткоживущие токены сессии после проверки подписи мессенджера
 */
export async function registerSecurity(app: FastifyInstance, cfg: AppConfig): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // AI: У same-origin и серверных запросов нет заголовка Origin.
      if (!origin || cfg.corsOrigins.includes(origin)) return cb(null, true);
      // AI: Неизвестный origin: отвечаем без CORS-заголовков (браузер заблокирует сам), а не 500.
      cb(null, false);
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  await app.register(jwt, { secret: cfg.JWT_SECRET, sign: { expiresIn: cfg.JWT_TTL } });

  await app.register(rateLimit, {
    max: cfg.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      // AI: Предпочитаем id пользователя из валидного токена; анонимный трафик ограничивается по
      // IP.
      try {
        const claims = app.jwt.decode<SessionClaims>(bearer(req) ?? '');
        if (claims?.sub) return `u:${claims.sub}`;
      } catch {
        /* проваливаемся дальше */
      }
      return `ip:${req.ip}`;
    },
  });

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  const verified = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    if (req.user.scope === 'guest') {
      reply.code(403).send({ error: 'forbidden' });
      return false;
    }
    return true;
  };
  const isAdmin = (req: FastifyRequest) =>
    cfg.adminUsers.has(`${req.user.platform}:${req.user.puid}`);

  app.decorate('requireOperator', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await verified(req, reply))) return;
    if (cfg.OPERATOR_OPEN_ACCESS) return;
    const byGroup = req.user.roles?.includes('operator') ?? false;
    if (!isAdmin(req) && !byGroup) reply.code(403).send({ error: 'forbidden' });
  });

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await verified(req, reply))) return;
    if (!isAdmin(req)) reply.code(403).send({ error: 'forbidden' });
  });
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}
