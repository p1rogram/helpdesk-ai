import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Client as LdapClient } from 'ldapts';
import nodemailer, { type Transporter } from 'nodemailer';
import { AuthError } from './telegram.js';

/**
 * Corporate identity socket. The assistant needs to know WHO the user is in the organisation
 * (student / staff, groups for the operator role). Three providers cover what an IT department
 * can realistically hand over; all of them yield the same CorporateIdentity and the same JWT.
 *
 *   oidc   - SSO via OpenID Connect / OAuth2 (Keycloak, ADFS, any standards-compliant IdP)
 *   ldap   - login + password checked by an LDAP/Active Directory bind (the tpu.ru domain)
 *   email  - one-time code sent to the corporate mailbox (login@tpu.ru), when no domain access
 *
 * Nothing here stores passwords: LDAP binds with the user's credentials and forgets them;
 * OIDC never sees them; email codes are hashed and expire.
 */
export interface CorporateIdentity {
  /** Stable id inside the organisation (login / sub / e-mail local part). */
  id: string;
  displayName: string;
  email?: string;
  /** Group memberships (LDAP memberOf / OIDC groups claim) - mapped to roles by the app. */
  groups: string[];
}

// ---------------------------------------------------------------------------
// OIDC / OAuth2 (authorization code + PKCE)
// ---------------------------------------------------------------------------

export interface OidcOptions {
  /** Issuer URL; `/.well-known/openid-configuration` is fetched from it. */
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: string;
  /** Claim names - differ between IdPs (Keycloak: preferred_username / groups; ADFS: upn / role). */
  claims?: { id?: string; name?: string; email?: string; groups?: string };
  fetchImpl?: typeof fetch;
}

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
}

interface PendingLogin {
  verifier: string;
  createdAt: number;
  returnTo: string;
}

export class OidcProvider {
  readonly kind = 'oidc';
  private discovery: OidcDiscovery | null = null;
  private readonly pending = new Map<string, PendingLogin>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: OidcOptions) {
    this.fetchImpl = o.fetchImpl ?? globalThis.fetch;
  }

  private async config(): Promise<OidcDiscovery> {
    if (this.discovery) return this.discovery;
    const res = await this.fetchImpl(`${this.o.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`oidc discovery failed: HTTP ${res.status}`);
    this.discovery = (await res.json()) as OidcDiscovery;
    return this.discovery;
  }

  /** Step 1: build the redirect URL. `state` binds the callback to this login attempt. */
  async startLogin(returnTo: string): Promise<string> {
    const d = await this.config();
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.pending.set(state, { verifier, createdAt: Date.now(), returnTo });
    this.gc();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.o.clientId,
      redirect_uri: this.o.redirectUri,
      scope: this.o.scopes ?? 'openid profile email',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${d.authorization_endpoint}?${q.toString()}`;
  }

  /** Step 2: exchange the code, read the identity. */
  async finishLogin(code: string, state: string): Promise<{ identity: CorporateIdentity; returnTo: string }> {
    const p = this.pending.get(state);
    if (!p || Date.now() - p.createdAt > 10 * 60_000) throw new AuthError('oidc: unknown or expired state');
    this.pending.delete(state);
    const d = await this.config();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.o.redirectUri,
      client_id: this.o.clientId,
      code_verifier: p.verifier,
      ...(this.o.clientSecret ? { client_secret: this.o.clientSecret } : {}),
    });
    const tok = await this.fetchImpl(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!tok.ok) throw new AuthError(`oidc: token exchange failed (${tok.status})`);
    const tokens = (await tok.json()) as { access_token?: string; id_token?: string };

    // Prefer userinfo (fresh, includes groups on most IdPs); fall back to id_token claims.
    let claims: Record<string, unknown> = {};
    if (d.userinfo_endpoint && tokens.access_token) {
      const ui = await this.fetchImpl(d.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (ui.ok) claims = (await ui.json()) as Record<string, unknown>;
    }
    if (!Object.keys(claims).length && tokens.id_token) claims = decodeJwtPayload(tokens.id_token);

    const c = this.o.claims ?? {};
    const id = str(claims[c.id ?? 'preferred_username']) ?? str(claims.sub);
    if (!id) throw new AuthError('oidc: no user id claim');
    const groupsRaw = claims[c.groups ?? 'groups'];
    return {
      identity: {
        id,
        displayName: str(claims[c.name ?? 'name']) ?? id,
        email: str(claims[c.email ?? 'email']),
        groups: Array.isArray(groupsRaw) ? groupsRaw.map(String) : typeof groupsRaw === 'string' ? [groupsRaw] : [],
      },
      returnTo: p.returnTo,
    };
  }

  private gc() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of this.pending) if (v.createdAt < cutoff) this.pending.delete(k);
  }
}

/** id_token payload without signature verification - acceptable only because it came straight from the token endpoint over TLS. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// ---------------------------------------------------------------------------
// LDAP / Active Directory bind
// ---------------------------------------------------------------------------

export interface LdapOptions {
  /** ldaps://dc.tpu.ru:636 (LDAPS strongly preferred; plain ldap:// only inside a trusted network). */
  url: string;
  /** How the login becomes a bind DN / UPN. `{login}` is replaced. AD: `{login}@tpu.ru` or `TPU\\{login}`. */
  bindTemplate: string;
  /** Where to search the user entry after a successful bind (for name / mail / groups). */
  baseDn: string;
  /** Filter with `{login}`; AD: `(sAMAccountName={login})`, OpenLDAP: `(uid={login})`. */
  searchFilter?: string;
  attributes?: { name?: string; email?: string; groups?: string };
  tlsRejectUnauthorized?: boolean;
}

export class LdapProvider {
  readonly kind = 'ldap';
  constructor(private readonly o: LdapOptions) {}

  async login(login: string, password: string): Promise<CorporateIdentity> {
    const clean = login.trim().replace(/@.*$/, '').replace(/^.*\\/, '');
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(clean)) throw new AuthError('ldap: bad login format');
    if (!password) throw new AuthError('ldap: empty password');

    const client = new LdapClient({
      url: this.o.url,
      timeout: 10_000,
      connectTimeout: 10_000,
      tlsOptions: { rejectUnauthorized: this.o.tlsRejectUnauthorized ?? true },
    });
    try {
      // The bind IS the password check. Credentials are used once and never persisted.
      await client.bind(this.o.bindTemplate.replace('{login}', clean), password);
      const a = this.o.attributes ?? {};
      const nameAttr = a.name ?? 'displayName';
      const mailAttr = a.email ?? 'mail';
      const groupAttr = a.groups ?? 'memberOf';
      const { searchEntries } = await client.search(this.o.baseDn, {
        scope: 'sub',
        filter: (this.o.searchFilter ?? '(sAMAccountName={login})').replace('{login}', clean),
        attributes: [nameAttr, mailAttr, groupAttr],
        sizeLimit: 1,
      });
      const e = searchEntries[0] as Record<string, unknown> | undefined;
      const groupsRaw = e?.[groupAttr];
      return {
        id: clean.toLowerCase(),
        displayName: str(e?.[nameAttr]) ?? clean,
        email: str(e?.[mailAttr]),
        groups: Array.isArray(groupsRaw) ? groupsRaw.map(String) : typeof groupsRaw === 'string' ? [groupsRaw] : [],
      };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      // Invalid credentials and connection problems both end here; do not leak which.
      throw new AuthError('ldap: authentication failed');
    } finally {
      await client.unbind().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// One-time code to the corporate mailbox
// ---------------------------------------------------------------------------

export interface EmailCodeOptions {
  /** Allowed mail domains, e.g. ["tpu.ru"]. */
  domains: string[];
  smtp: { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string };
  ttlSeconds?: number;
}

export class EmailCodeProvider {
  readonly kind = 'email';
  private readonly codes = new Map<string, { hash: string; expires: number; attempts: number }>();
  private readonly transport: Transporter;

  constructor(private readonly o: EmailCodeOptions) {
    this.transport = nodemailer.createTransport({
      host: o.smtp.host,
      port: o.smtp.port,
      secure: o.smtp.secure,
      ...(o.smtp.user ? { auth: { user: o.smtp.user, pass: o.smtp.pass ?? '' } } : {}),
    });
  }

  private normalise(email: string): string {
    const e = email.trim().toLowerCase();
    const domain = e.split('@')[1];
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+$/.test(e) || !domain || !this.o.domains.includes(domain)) {
      throw new AuthError('email: only corporate addresses are allowed');
    }
    return e;
  }

  async requestCode(email: string): Promise<void> {
    const e = this.normalise(email);
    const code = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
    this.codes.set(e, {
      hash: createHash('sha256').update(code).digest('hex'),
      expires: Date.now() + (this.o.ttlSeconds ?? 600) * 1000,
      attempts: 0,
    });
    await this.transport.sendMail({
      from: this.o.smtp.from,
      to: e,
      subject: 'Код входа в помощник поддержки',
      text: `Ваш код: ${code}\nОн действует ${Math.round((this.o.ttlSeconds ?? 600) / 60)} минут. Если вы не запрашивали вход, просто проигнорируйте письмо.`,
    });
  }

  async verifyCode(email: string, code: string): Promise<CorporateIdentity> {
    const e = this.normalise(email);
    const rec = this.codes.get(e);
    if (!rec || rec.expires < Date.now()) throw new AuthError('email: code expired');
    if (++rec.attempts > 5) {
      this.codes.delete(e);
      throw new AuthError('email: too many attempts');
    }
    const given = createHash('sha256').update(code.trim()).digest('hex');
    if (!timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(rec.hash, 'hex'))) throw new AuthError('email: wrong code');
    this.codes.delete(e);
    const local = e.split('@')[0]!;
    return { id: local, displayName: local, email: e, groups: [] };
  }
}

/** Map organisation groups to app roles. `operatorGroups` = DNs / names that grant the operator console. */
export function rolesFor(identity: CorporateIdentity, operatorGroups: Set<string>): string[] {
  const roles: string[] = [];
  const hit = identity.groups.some((g) => operatorGroups.has(g) || operatorGroups.has(g.split(',')[0]?.replace(/^CN=/i, '') ?? ''));
  if (hit) roles.push('operator');
  return roles;
}
