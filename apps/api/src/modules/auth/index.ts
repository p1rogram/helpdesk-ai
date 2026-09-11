import type { Platform, Scope } from '@helpdesk/shared';
import { AuthError, displayNameOf, verifyTelegramInitData } from './telegram.js';
import { verifyVkLaunchParams } from './vk.js';
import { verifyMaxInitData } from './max.js';

export { AuthError } from './telegram.js';

export interface VerifiedIdentity {
  platform: Platform;
  platformUserId: string;
  displayName: string;
}

/** AI: One verifier per messenger. Adding VK / MAX = adding one file that implements this. */
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

/** AI: VK Mini Apps: the client posts window.location.search (vk_* params + sign). */
export function vkVerifier(appSecret: string, appId?: string): PlatformVerifier {
  return {
    platform: 'vk',
    verify(launchParams) {
      const v = verifyVkLaunchParams(launchParams, appSecret, { expectedAppId: appId });
      // AI: VK does not include the name in launch params; the client may pass it separately later.
      return { platform: 'vk', platformUserId: v.userId, displayName: `vk:${v.userId}` };
    },
  };
}

/** AI: MAX Mini Apps: same init-data model as Telegram. */
export function maxVerifier(botToken: string, secretLabel?: string): PlatformVerifier {
  return {
    platform: 'max',
    verify(initData) {
      const v = verifyMaxInitData(initData, botToken, { secretLabel });
      const name = [v.user.first_name, v.user.last_name].filter(Boolean).join(' ') || v.user.username || `max:${v.user.id}`;
      return { platform: 'max', platformUserId: String(v.user.id), displayName: name };
    },
  };
}

/** AI: Guest identity for the plain-web demo. Enabled only with AUTH_DEV_BYPASS=true. */
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

/** AI: JWT claims we issue. Short-lived; the client re-authenticates with fresh initData. */
export interface SessionClaims {
  sub: string; // users.id
  platform: Platform;
  puid: string; // platform user id
  name: string;
  tenant: string;
  /** AI: 'guest' sees only the public part of the knowledge base. */
  scope?: Scope;
  /** AI: App roles derived from organisation groups (corporate login) - e.g. 'operator'. */
  roles?: string[];
}
