import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Client as LdapClient } from 'ldapts';
import nodemailer, { type Transporter } from 'nodemailer';
import { AuthError } from './telegram.js';

/**
 * AI: Розетка корпоративной идентификации. Помощнику нужно знать, КТО пользователь в организации
 * (студент / сотрудник, группы для роли оператора). Три провайдера покрывают то, что реально может
 * выдать IT-служба; все дают одинаковый CorporateIdentity и одинаковый JWT.
 *
 *   oidc   - SSO через OpenID Connect / OAuth2 (Keycloak, ADFS, любой стандартный IdP)
 *   ldap   - логин + пароль проверяются bind-ом к LDAP/Active Directory (домен tpu.ru)
 *   email  - одноразовый код на корпоративную почту (login@tpu.ru), когда доступа к домену нет
 *
 * Пароли здесь не хранятся: LDAP делает bind учётными данными пользователя и забывает их; OIDC их
 * не видит; коды на почту хэшируются и истекают.
 */
export interface CorporateIdentity {
  /** AI: Стабильный id внутри организации (логин / sub / локальная часть e-mail). */
  id: string;
  displayName: string;
  email?: string;
  /**
   * AI: Членство в группах (LDAP memberOf / claim groups в OIDC) - приложение сопоставляет их с
   * ролями.
   */
  groups: string[];
}

// ---------------------------------------------------------------------------
// OIDC / OAuth2 (authorization code + PKCE)
// ---------------------------------------------------------------------------

export interface OidcOptions {
  /** AI: URL issuer; с него читается `/.well-known/openid-configuration`. */
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: string;
  /**
   * AI: Имена claim - у разных IdP разные (Keycloak: preferred_username / groups; ADFS: upn /
   * role).
   */
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
    const res = await this.fetchImpl(
      `${this.o.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) throw new Error(`oidc discovery failed: HTTP ${res.status}`);
    this.discovery = (await res.json()) as OidcDiscovery;
    return this.discovery;
  }

  /** AI: Шаг 1: собрать URL редиректа. `state` привязывает callback к этой попытке входа. */
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

  /** AI: Шаг 2: обменять код на токен, прочитать идентичность. */
  async finishLogin(
    code: string,
    state: string,
  ): Promise<{ identity: CorporateIdentity; returnTo: string }> {
    const p = this.pending.get(state);
    if (!p || Date.now() - p.createdAt > 10 * 60_000)
      throw new AuthError('oidc: unknown or expired state');
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

    // AI: Предпочитаем userinfo (свежие данные, у большинства IdP там есть группы); запасной
    // вариант - claims из id_token.
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
        groups: Array.isArray(groupsRaw)
          ? groupsRaw.map(String)
          : typeof groupsRaw === 'string'
            ? [groupsRaw]
            : [],
      },
      returnTo: p.returnTo,
    };
  }

  private gc() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of this.pending) if (v.createdAt < cutoff) this.pending.delete(k);
  }
}

/**
 * AI: Payload id_token без проверки подписи - допустимо только потому, что он пришёл напрямую с
 * token endpoint по TLS.
 */
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
// Bind к LDAP / Active Directory
// ---------------------------------------------------------------------------

export interface LdapOptions {
  /**
   * AI: ldaps://dc.tpu.ru:636 (LDAPS настоятельно рекомендуется; обычный ldap:// - только внутри
   * доверенной сети).
   */
  url: string;
  /**
   * AI: Как логин превращается в bind DN / UPN. `{login}` подставляется. AD: `{login}@tpu.ru` или
   * `TPU\\{login}`.
   */
  bindTemplate: string;
  /** AI: Где искать запись пользователя после успешного bind (имя / почта / группы). */
  baseDn: string;
  /** AI: Фильтр с `{login}`; AD: `(sAMAccountName={login})`, OpenLDAP: `(uid={login})`. */
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
      // AI: Bind И ЕСТЬ проверка пароля. Учётные данные используются один раз и нигде не
      // сохраняются.
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
        groups: Array.isArray(groupsRaw)
          ? groupsRaw.map(String)
          : typeof groupsRaw === 'string'
            ? [groupsRaw]
            : [],
      };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      // AI: Неверные учётные данные и проблемы соединения заканчиваются здесь одинаково; не
      // раскрываем, что именно.
      throw new AuthError('ldap: authentication failed');
    } finally {
      await client.unbind().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Одноразовый код на корпоративную почту
// ---------------------------------------------------------------------------

export interface EmailCodeOptions {
  /** AI: Разрешённые почтовые домены, например ["tpu.ru"]. */
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
    if (!timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(rec.hash, 'hex')))
      throw new AuthError('email: wrong code');
    this.codes.delete(e);
    const local = e.split('@')[0]!;
    return { id: local, displayName: local, email: e, groups: [] };
  }
}

/**
 * AI: Сопоставление групп организации с ролями приложения. `operatorGroups` = DN / имена групп,
 * дающие консоль оператора.
 */
export function rolesFor(identity: CorporateIdentity, operatorGroups: Set<string>): string[] {
  const roles: string[] = [];
  const hit = identity.groups.some(
    (g) => operatorGroups.has(g) || operatorGroups.has(g.split(',')[0]?.replace(/^CN=/i, '') ?? ''),
  );
  if (hit) roles.push('operator');
  return roles;
}
