import type { Platform } from '@helpdesk/shared';
import { AuthError, displayNameOf, verifyTelegramInitData } from './telegram.js';

export { AuthError } from './telegram.js';

export interface VerifiedIdentity {
  platform: Platform;
  platformUserId: string;
  displayName: string;
}

/** One verifier per messenger. Adding VK / MAX = adding one file that implements this. */
export interface PlatformVerifier {
  platform: Platform;
  verify(payload: string): Promise<VerifiedIdentity> | VerifiedIdentity;
}

export function telegramVerifier(botToken: string): PlatformVerifier {
  return {
    platform: 'telegram',
    verify(initData) {
      const v = verifyTelegramInitData(initData, botToken);
      return { platform: 'telegram', platformUserId: String(v.user.id), displayName: displayNameOf(v.user) };
    },
  };
}

/** Guest identity for the plain-web demo. Enabled only with AUTH_DEV_BYPASS=true. */
export function devVerifier(): PlatformVerifier {
  return {
    platform: 'web',
    verify(name) {
      const clean = name.trim().slice(0, 64);
      if (!clean) throw new AuthError('name required');
      return { platform: 'web', platformUserId: clean.toLowerCase(), displayName: clean };
    },
  };
}

/** JWT claims we issue. Short-lived; the client re-authenticates with fresh initData. */
export interface SessionClaims {
  sub: string; // users.id
  platform: Platform;
  puid: string; // platform user id
  name: string;
  tenant: string;
}
