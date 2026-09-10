import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AuthError } from '../modules/auth/index.js';
import { rolesFor, type CorporateIdentity } from '../modules/auth/corporate.js';

/**
 * Corporate login routes. Which ones exist depends on what the organisation provided:
 *   GET  /api/auth/providers            -> what the client should offer
 *   GET  /api/auth/sso/start            -> redirect to the IdP (OIDC)
 *   GET  /api/auth/sso/callback         -> IdP returns here; we redirect to the app with the token
 *   POST /api/auth/ldap {login,password}
 *   POST /api/auth/email/request {email} ; POST /api/auth/email/verify {email, code}
 */
export async function corporateAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { corporate } = ctx;

  app.get('/api/auth/providers', async () => ({
    providers: {
      telegram: ctx.verifiers.has('telegram'),
      vk: ctx.verifiers.has('vk'),
      max: ctx.verifiers.has('max'),
      guest: ctx.verifiers.has('web'),
      sso: Boolean(corporate.oidc),
      ldap: Boolean(corporate.ldap),
      email: Boolean(corporate.email),
    },
    ssoLabel: ctx.config.SSO_LABEL,
    emailDomains: ctx.config.EMAIL_AUTH_DOMAINS ? ctx.config.EMAIL_AUTH_DOMAINS.split(',') : [],
  }));

  if (corporate.oidc) {
    const oidc = corporate.oidc;
    app.get('/api/auth/sso/start', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { returnTo } = z.object({ returnTo: z.string().max(512).optional() }).parse(req.query ?? {});
      const target = safeReturnTo(returnTo, ctx.config.WEB_APP_URL);
      return reply.redirect(await oidc.startLogin(target));
    });

    app.get('/api/auth/sso/callback', async (req, reply) => {
      const q = z.object({ code: z.string().min(1), state: z.string().min(1) }).safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: 'bad_request' });
      try {
        const { identity, returnTo } = await oidc.finishLogin(q.data.code, q.data.state);
        const token = await issueCorporate(ctx, identity);
        // Token travels in the URL fragment: never sent to the server again, not logged by proxies.
        return reply.redirect(`${returnTo}#token=${encodeURIComponent(token)}`);
      } catch (err) {
        if (err instanceof AuthError) return reply.code(401).send({ error: 'sso_failed', message: err.message });
        throw err;
      }
    });
  }

  if (corporate.ldap) {
    const ldap = corporate.ldap;
    app.post('/api/auth/ldap', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const body = z.object({ login: z.string().min(1).max(128), password: z.string().min(1).max(256) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_request' });
      try {
        const identity = await ldap.login(body.data.login, body.data.password);
        return { token: await issueCorporate(ctx, identity), user: { displayName: identity.displayName } };
      } catch (err) {
        if (err instanceof AuthError) return reply.code(401).send({ error: 'invalid_credentials' });
        throw err;
      }
    });
  }

  if (corporate.email) {
    const email = corporate.email;
    app.post('/api/auth/email/request', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
      const body = z.object({ email: z.string().email().max(128) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_request' });
      try {
        await email.requestCode(body.data.email);
        return { ok: true };
      } catch (err) {
        if (err instanceof AuthError) return reply.code(400).send({ error: 'not_allowed', message: err.message });
        req.log.error(err, 'email code send failed');
        return reply.code(502).send({ error: 'mail_unavailable' });
      }
    });
    app.post('/api/auth/email/verify', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
      const body = z.object({ email: z.string().email().max(128), code: z.string().min(4).max(8) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_request' });
      try {
        const identity = await email.verifyCode(body.data.email, body.data.code);
        return { token: await issueCorporate(ctx, identity), user: { displayName: identity.displayName } };
      } catch (err) {
        if (err instanceof AuthError) return reply.code(401).send({ error: 'invalid_code' });
        throw err;
      }
    });
  }
}

/** Corporate identities share the `corp` platform; roles come from organisation groups. */
async function issueCorporate(ctx: AppContext, identity: CorporateIdentity): Promise<string> {
  const user = await ctx.tickets.upsertUser('corp', identity.id, identity.displayName);
  const roles = rolesFor(identity, ctx.config.operatorGroups);
  return ctx.app.jwt.sign({
    sub: user.id,
    platform: 'corp',
    puid: identity.id,
    name: identity.displayName,
    tenant: ctx.config.DEFAULT_TENANT,
    roles,
  });
}

/** Only allow returning to our own app origin (open-redirect protection). */
function safeReturnTo(candidate: string | undefined, appUrl: string | undefined): string {
  const fallback = appUrl ?? '/';
  if (!candidate) return fallback;
  try {
    const u = new URL(candidate, appUrl ?? 'http://localhost');
    if (appUrl && u.origin !== new URL(appUrl).origin) return fallback;
    return u.toString();
  } catch {
    return fallback;
  }
}
