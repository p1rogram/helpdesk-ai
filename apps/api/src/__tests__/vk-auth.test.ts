import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyVkLaunchParams } from '../modules/auth/vk.js';

const SECRET = 'vk-app-secret';
const now = Math.floor(Date.now() / 1000);

function signed(params: Record<string, string>, secret = SECRET): string {
  const base = Object.entries(params)
    .filter(([k]) => k.startsWith('vk_'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const sign = createHmac('sha256', secret).update(base).digest('base64url');
  return '?' + new URLSearchParams({ ...params, sign }).toString();
}

describe('verifyVkLaunchParams', () => {
  const params = {
    vk_user_id: '12345',
    vk_app_id: '777',
    vk_ts: String(now),
    vk_platform: 'mobile_android',
    vk_language: 'ru',
  };

  it('accepts a correctly signed launch string', () => {
    const v = verifyVkLaunchParams(signed(params), SECRET, { expectedAppId: '777' });
    expect(v.userId).toBe('12345');
    expect(v.language).toBe('ru');
  });
  it('rejects a wrong secret', () => {
    expect(() => verifyVkLaunchParams(signed(params, 'other'), SECRET)).toThrow(/signature/);
  });
  it('rejects a foreign app id', () => {
    expect(() => verifyVkLaunchParams(signed(params), SECRET, { expectedAppId: '1' })).toThrow(
      /app id/,
    );
  });
});
