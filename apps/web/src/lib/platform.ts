/**
 * Platform adapter. One interface, one implementation per messenger. The rest of the app
 * never touches window.Telegram / vkBridge / MAX directly. Adding VK or MAX = one more file.
 */
export type PlatformKind = 'telegram' | 'vk' | 'max' | 'web';

export interface PlatformAdapter {
  kind: PlatformKind;
  /** Opaque auth payload verified by the server (Telegram: initData). */
  authPayload(): string | null;
  displayName(): string | null;
  /** Theme colours from the host app, as CSS variables. */
  themeVars(): Record<string, string>;
  isDark(): boolean;
  ready(): void;
  haptic(kind: 'light' | 'success' | 'error'): void;
  expand(): void;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: { first_name?: string; last_name?: string } };
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
  ready(): void;
  expand(): void;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
    notificationOccurred(type: 'success' | 'error' | 'warning'): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

function telegramAdapter(tg: TelegramWebApp): PlatformAdapter {
  return {
    kind: 'telegram',
    authPayload: () => tg.initData || null,
    displayName: () => {
      const u = tg.initDataUnsafe?.user;
      return u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : null;
    },
    themeVars: () => {
      const p = tg.themeParams ?? {};
      const map: Record<string, string> = {};
      if (p.bg_color) map['--bg'] = p.bg_color;
      if (p.secondary_bg_color) map['--bg-2'] = p.secondary_bg_color;
      if (p.text_color) map['--fg'] = p.text_color;
      if (p.hint_color) map['--muted'] = p.hint_color;
      if (p.button_color) map['--accent'] = p.button_color;
      if (p.button_text_color) map['--accent-fg'] = p.button_text_color;
      if (p.link_color) map['--link'] = p.link_color;
      return map;
    },
    isDark: () => tg.colorScheme === 'dark',
    ready: () => tg.ready(),
    haptic: (k) =>
      k === 'light' ? tg.HapticFeedback?.impactOccurred('light') : tg.HapticFeedback?.notificationOccurred(k),
    expand: () => tg.expand(),
  };
}

function webAdapter(): PlatformAdapter {
  return {
    kind: 'web',
    authPayload: () => null,
    displayName: () => null,
    themeVars: () => ({}),
    isDark: () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
    ready: () => {},
    haptic: () => {},
    expand: () => {},
  };
}

export function detectPlatform(): PlatformAdapter {
  const tg = window.Telegram?.WebApp;
  // initData is empty when the page is opened outside Telegram even though the SDK loaded.
  if (tg && tg.initData) return telegramAdapter(tg);
  return webAdapter();
}
