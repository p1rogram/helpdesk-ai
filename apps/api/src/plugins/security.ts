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
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Edge protections in one place:
 *  - helmet: security headers (CSP is set by the web app's own server; API returns JSON only)
 *  - cors: allow-list of origins (Mini App origin + local dev)
 *  - rate-limit: per authenticated user, falling back to IP - protects the LLM budget
 *  - jwt: short-lived session tokens issued after messenger signature verification
 */
export async function registerSecurity(app: FastifyInstance, cfg: AppConfig): Promise<void> {
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin / server-to-server requests have no Origin header.
      if (!origin || cfg.corsOrigins.includes(origin)) return cb(null, true);
      // Unknown origin: answer without CORS headers (browser blocks it) instead of a 500.
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
      // Prefer the user id from a valid token; anonymous traffic is limited per IP.
      try {
        const claims = app.jwt.decode<SessionClaims>(bearer(req) ?? '');
        if (claims?.sub) return `u:${claims.sub}`;
      } catch {
        /* fallthrough */
      }
      return `ip:${req.ip}`;
    },
    errorResponseBuilder: () => ({ error: 'too_many_requests', message: 'Слишком много запросов. Подождите минуту.' }),
  });

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const key = `${req.user.platform}:${req.user.puid}`;
    if (!cfg.adminUsers.has(key)) reply.code(403).send({ error: 'forbidden' });
  });
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}
