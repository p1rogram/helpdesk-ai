/**
 * AI: Адаптер платформы. Один интерфейс, одна реализация на мессенджер. Остальное приложение
 * никогда не трогает window.Telegram / vkBridge / MAX напрямую. Добавить VK или MAX = ещё один
 * файл.
 */
export type PlatformKind = 'telegram' | 'vk' | 'max' | 'web';

export interface PlatformAdapter {
  kind: PlatformKind;
  /** AI: Непрозрачный payload для входа, который проверяет сервер (Telegram: initData). */
  authPayload(): string | null;
  /** AI: Цвета темы хост-приложения в виде CSS-переменных. */
  themeVars(): Record<string, string>;
  isDark(): boolean;
  ready(): void;
  haptic(kind: 'light' | 'success' | 'error'): void;
  expand(): void;
  /** AI: Нативный диалог да/нет хоста (попап Telegram, confirm браузера). */
  confirm(message: string): Promise<boolean>;
}

interface TelegramWebApp {
  initData: string;
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
  ready(): void;
  expand(): void;
  showConfirm?(message: string, callback: (ok: boolean) => void): void;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
    notificationOccurred(type: 'success' | 'error' | 'warning'): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
    vkBridge?: VkBridgeLike;
    Max?: { WebApp?: MaxWebApp };
  }
}

function telegramAdapter(tg: TelegramWebApp): PlatformAdapter {
  return {
    kind: 'telegram',
    authPayload: () => tg.initData || null,
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
      k === 'light'
        ? tg.HapticFeedback?.impactOccurred('light')
        : tg.HapticFeedback?.notificationOccurred(k),
    expand: () => tg.expand(),
    confirm: (message) =>
      tg.showConfirm
        ? new Promise((resolve) => tg.showConfirm!(message, resolve))
        : Promise.resolve(window.confirm(message)),
  };
}

interface VkBridgeLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * AI: VK Mini Apps: параметры запуска приходят в URL и проверяются на сервере; UI-хуки идут через
 * vk-bridge (загружает хост). Подключены только части, которые использует приложение; остальное -
 * no-op.
 */
function vkAdapter(bridge: VkBridgeLike | undefined): PlatformAdapter {
  return {
    kind: 'vk',
    authPayload: () => window.location.search || null,
    themeVars: () => ({}),
    isDark: () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
    ready: () => void bridge?.send('VKWebAppInit'),
    haptic: (k) =>
      void bridge?.send('VKWebAppTapticImpactOccurred', {
        style: k === 'light' ? 'light' : 'medium',
      }),
    expand: () => {},
    confirm: (message) => Promise.resolve(window.confirm(message)),
  };
}

interface MaxWebApp {
  initData: string;
  colorScheme?: 'light' | 'dark';
  ready?(): void;
  expand?(): void;
}

/**
 * AI: MAX Mini Apps предоставляют объект `WebApp` в духе Telegram; адаптер повторяет
 * телеграмовский.
 */
function maxAdapter(m: MaxWebApp): PlatformAdapter {
  return {
    kind: 'max',
    authPayload: () => m.initData || null,
    themeVars: () => ({}),
    isDark: () => m.colorScheme === 'dark',
    ready: () => m.ready?.(),
    haptic: () => {},
    expand: () => m.expand?.(),
    confirm: (message) => Promise.resolve(window.confirm(message)),
  };
}

function webAdapter(): PlatformAdapter {
  return {
    kind: 'web',
    authPayload: () => null,
    themeVars: () => ({}),
    isDark: () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
    ready: () => {},
    haptic: () => {},
    expand: () => {},
    confirm: (message) => Promise.resolve(window.confirm(message)),
  };
}

export function detectPlatform(): PlatformAdapter {
  const tg = window.Telegram?.WebApp;
  // AI: initData пуст, когда страница открыта вне Telegram, даже если SDK загрузился.
  if (tg && tg.initData) return telegramAdapter(tg);
  const mx = window.Max?.WebApp;
  if (mx && mx.initData) return maxAdapter(mx);
  if (new URLSearchParams(window.location.search).has('vk_app_id'))
    return vkAdapter(window.vkBridge);
  return webAdapter();
}
