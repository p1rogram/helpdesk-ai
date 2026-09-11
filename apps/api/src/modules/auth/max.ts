import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError } from './telegram.js';

/**
 * AI: MAX (max.ru) Mini Apps. Платформа повторяет модель Telegram WebApp: клиент получает
 * подписанные init data с `user`, `auth_date` и `hash`; секрет выводится из токена бота.
 *
 * Точная строка вывода секрета берётся из документации разработчика MAX при интеграции
 * (`MAX_SECRET_LABEL`, по умолчанию "WebAppData", как в Telegram). Всё остальное - разбор,
 * сравнение за постоянное время, окно replay - общее с верификатором Telegram, так что включить MAX
 * = токен бота из консоли MAX + эта метка. Других правок кода нет.
 */
export interface VerifiedMaxInit {
  user: { id: number | string; first_name?: string; last_name?: string; username?: string };
  authDate: Date;
}

export function verifyMaxInitData(
  initData: string,
  botToken: string,
  opts: { secretLabel?: string; maxAgeSeconds?: number; now?: () => number } = {},
): VerifiedMaxInit {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new AuthError('max: missing hash');
  params.delete('hash');
  const dcs = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', opts.secretLabel ?? 'WebAppData')
    .update(botToken)
    .digest();
  const expected = createHmac('sha256', secret).update(dcs).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AuthError('max: bad signature');

  const authDate = Number(params.get('auth_date'));
  const now = (opts.now ?? Date.now)() / 1000;
  if (!Number.isFinite(authDate) || now - authDate > (opts.maxAgeSeconds ?? 24 * 3600))
    throw new AuthError('max: expired');

  const raw = params.get('user');
  if (!raw) throw new AuthError('max: missing user');
  let user: VerifiedMaxInit['user'];
  try {
    user = JSON.parse(raw) as VerifiedMaxInit['user'];
  } catch {
    throw new AuthError('max: bad user json');
  }
  if (user.id === undefined) throw new AuthError('max: bad user');
  return { user, authDate: new Date(authDate * 1000) };
}
