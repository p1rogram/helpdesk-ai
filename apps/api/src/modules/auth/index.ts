import type { Platform, Scope } from '@helpdesk/shared';
import { createHash } from 'node:crypto';
import { AuthError, verifyTelegramInitData } from './telegram.js';
import { verifyVkLaunchParams } from './vk.js';
import { verifyMaxInitData } from './max.js';

export { AuthError } from './telegram.js';

export interface VerifiedIdentity {
  platform: Platform;
  platformUserId: string;
  /** AI: Всегда псевдоним - см. `pseudonym()`. */
  displayName: string;
}

/**
 * AI: Минимизация данных (152-ФЗ): сервис никогда не хранит то, что мессенджер или каталог знают о
 * человеке - ни имени, ни фамилии, ни username. К пользователю обращаемся по стабильному
 * псевдониму, выведенному из id платформы («Пользователь 4F2A9C»); операторы видят то же самое.
 */
export function pseudonym(platform: string, platformUserId: string): string {
  const tag = createHash('sha256')
    .update(`${platform}:${platformUserId}`)
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
  return `Пользователь ${tag}`;
}

/**
 * AI: Один верификатор на мессенджер. Добавить VK / MAX = добавить один файл, реализующий этот
 * интерфейс.
 */
export interface PlatformVerifier {
  platform: Platform;
  verify(payload: string): Promise<VerifiedIdentity> | VerifiedIdentity;
}

export function telegramVerifier(botToken: string): PlatformVerifier {
  return {
    platform: 'telegram',
    verify(initData) {
      const v = verifyTelegramInitData(initData, botToken);
      return {
        platform: 'telegram',
        platformUserId: String(v.user.id),
        displayName: pseudonym('telegram', String(v.user.id)),
      };
    },
  };
}

/** AI: VK Mini Apps: клиент присылает window.location.search (параметры vk_* + sign). */
export function vkVerifier(appSecret: string, appId?: string): PlatformVerifier {
  return {
    platform: 'vk',
    verify(launchParams) {
      const v = verifyVkLaunchParams(launchParams, appSecret, { expectedAppId: appId });
      // AI: VK не передаёт имя в параметрах запуска; клиент может передать его отдельно позже.
      return { platform: 'vk', platformUserId: v.userId, displayName: pseudonym('vk', v.userId) };
    },
  };
}

/** AI: MAX Mini Apps: та же модель init data, что у Telegram. */
export function maxVerifier(botToken: string, secretLabel?: string): PlatformVerifier {
  return {
    platform: 'max',
    verify(initData) {
      const v = verifyMaxInitData(initData, botToken, { secretLabel });
      return {
        platform: 'max',
        platformUserId: String(v.user.id),
        displayName: pseudonym('max', String(v.user.id)),
      };
    },
  };
}

/**
 * AI: Идентичность на сайте без провайдера: гость (WEB_GUEST_LOGIN) или демо-студент
 * (WEB_DEMO_LOGIN).
 */
export function devVerifier(): PlatformVerifier {
  return {
    platform: 'web',
    verify(name) {
      const clean = name.trim().slice(0, 64);
      if (!clean) throw new AuthError('name required');
      // AI: Введённое имя - только ключ, чтобы снова найти тот же демо-аккаунт; оно хэшируется, а
      // не хранится.
      const id = createHash('sha256').update(clean.toLowerCase()).digest('hex').slice(0, 16);
      return { platform: 'web', platformUserId: id, displayName: pseudonym('web', id) };
    },
  };
}

/** AI: Claims выдаваемого JWT. Короткоживущий; клиент заново проходит вход со свежими initData. */
export interface SessionClaims {
  sub: string; // users.id
  platform: Platform;
  puid: string; // platform user id
  name: string;
  tenant: string;
  /** AI: 'guest' видит только публичную часть базы знаний. */
  scope?: Scope;
  /**
   * AI: Роли приложения, выведенные из групп организации (корпоративный вход) - например
   * 'operator'.
   */
  roles?: string[];
}
