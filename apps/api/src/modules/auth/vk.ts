import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthError } from './telegram.js';

/**
 * AI: Параметры запуска VK Mini Apps. Приложение получает их в URL (`vk_user_id`, `vk_app_id`,
 * `vk_ts`, ..., `sign`); подпись - HMAC-SHA256 от отсортированной строки запроса `vk_*` секретным
 * ключом приложения в base64url. Документация:
 * dev.vk.com/ru/mini-apps/development/launch-params-sign
 */
export interface VerifiedVkLaunch {
  userId: string;
  appId: string;
  platform?: string;
  language?: string;
}

export function verifyVkLaunchParams(
  query: string,
  appSecret: string,
  opts: { expectedAppId?: string; maxAgeSeconds?: number; now?: () => number } = {},
): VerifiedVkLaunch {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const sign = params.get('sign');
  if (!sign) throw new AuthError('vk: missing sign');

  const vkParams = [...params.entries()]
    .filter(([k]) => k.startsWith('vk_'))
    .sort(([a], [b]) => a.localeCompare(b));
  const base = vkParams.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const expected = createHmac('sha256', appSecret).update(base).digest('base64url');

  const a = Buffer.from(expected);
  const b = Buffer.from(sign);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AuthError('vk: bad signature');

  const userId = params.get('vk_user_id');
  const appId = params.get('vk_app_id');
  if (!userId || !appId) throw new AuthError('vk: missing user/app id');
  if (opts.expectedAppId && appId !== opts.expectedAppId)
    throw new AuthError('vk: app id mismatch');

  const ts = Number(params.get('vk_ts'));
  const now = (opts.now ?? Date.now)() / 1000;
  if (Number.isFinite(ts) && now - ts > (opts.maxAgeSeconds ?? 24 * 3600))
    throw new AuthError('vk: expired');

  return {
    userId,
    appId,
    platform: params.get('vk_platform') ?? undefined,
    language: params.get('vk_language') ?? undefined,
  };
}
