import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyTelegramInitData } from '../modules/auth/telegram.js';

const BOT = '123456:TEST_TOKEN';

function sign(params: Record<string, string>, token = BOT): string {
  const dcs = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

const now = Math.floor(Date.now() / 1000);
const user = JSON.stringify({ id: 42, first_name: 'Иван', last_name: 'Петров' });

describe('verifyTelegramInitData', () => {
  it('accepts a correctly signed payload', () => {
    const v = verifyTelegramInitData(sign({ auth_date: String(now), user, query_id: 'q1' }), BOT);
    expect(v.user.id).toBe(42);
    expect(v.queryId).toBe('q1');
  });

  it('rejects a payload signed with another bot token', () => {
    expect(() =>
      verifyTelegramInitData(sign({ auth_date: String(now), user }, 'other'), BOT),
    ).toThrow(/signature/);
  });

  it('rejects tampered data', () => {
    const ok = sign({ auth_date: String(now), user });
    const tampered = ok.replace('42', '43');
    expect(() => verifyTelegramInitData(tampered, BOT)).toThrow(/signature/);
  });

  it('rejects expired payloads (replay protection)', () => {
    const old = now - 3 * 24 * 3600;
    expect(() => verifyTelegramInitData(sign({ auth_date: String(old), user }), BOT)).toThrow(
      /expired/,
    );
  });
});
