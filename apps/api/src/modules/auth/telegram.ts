import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface VerifiedInitData {
  user: TelegramUser;
  authDate: Date;
  queryId?: string;
}

/**
 * AI: Validates Telegram Mini App `initData` exactly as documented:
 * secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
 * hash   = HMAC_SHA256(key=secret, msg=data_check_string)
 * data_check_string = sorted "key=value" pairs (except hash) joined by "\n".
 * Constant-time comparison; rejects stale payloads (replay protection).
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  opts: { maxAgeSeconds?: number; now?: () => number } = {},
): VerifiedInitData {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new AuthError('initData: missing hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new AuthError('initData: bad signature');

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) throw new AuthError('initData: bad auth_date');
  const now = (opts.now ?? Date.now)() / 1000;
  const maxAge = opts.maxAgeSeconds ?? 24 * 3600;
  if (now - authDate > maxAge) throw new AuthError('initData: expired');

  const rawUser = params.get('user');
  if (!rawUser) throw new AuthError('initData: missing user');
  let user: TelegramUser;
  try {
    user = JSON.parse(rawUser) as TelegramUser;
  } catch {
    throw new AuthError('initData: bad user json');
  }
  if (typeof user.id !== 'number') throw new AuthError('initData: bad user');

  return {
    user,
    authDate: new Date(authDate * 1000),
    queryId: params.get('query_id') ?? undefined,
  };
}

export class AuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AuthError';
  }
}
