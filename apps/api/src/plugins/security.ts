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
    /** AI: Operator console: ADMIN_USERS, operator groups, or everyone in demo mode. */
    requireOperator: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** AI: Administration (catalog, RAG): ADMIN_USERS only - demo mode never opens this. */
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * AI: Edge protections in one place:
 *  - helmet: security headers (CSP is set by the web app's own server; API returns JSON only)
 *  - cors: allow-list of origins (Mini App origin + local dev)
 *  - rate-limit: per authenticated user, falling back to IP - protects the LLM budget
 *  - jwt: short-lived session tokens issued after messenger signature verification
 */
export async function registerSecurity(app: FastifyInstance, cfg: AppConfig): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // AI: Same-origin / server-to-server requests have no Origin header.
      if (!origin || cfg.corsOrigins.includes(origin)) return cb(null, true);
      // AI: Unknown origin: answer without CORS headers (browser blocks it) instead of a 500.
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
      // AI: Prefer the user id from a valid token; anonymous traffic is limited per IP.
      try {
        const claims = app.jwt.decode<SessionClaims>(bearer(req) ?? '');
        if (claims?.sub) return `u:${claims.sub}`;
      } catch {
        /* fallthrough */
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
