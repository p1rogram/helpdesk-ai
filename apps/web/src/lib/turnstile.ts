/**
 * AI: Cloudflare Turnstile на гостевом входе - невидимая проверка «это браузер, а не скрипт».
 * Скрипт подгружается только когда сервер прислал ключ сайта; в Mini App и без ключа не участвует.
 */
declare global {
  interface Window {
    turnstile?: {
      render(
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          'expired-callback'?: () => void;
          'error-callback'?: () => void;
          appearance?: 'always' | 'execute' | 'interaction-only';
          theme?: 'light' | 'dark' | 'auto';
        },
      ): string;
      reset(id?: string): void;
      remove(id?: string): void;
    };
  }
}

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<void> | null = null;

export function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('turnstile load failed'));
      document.head.appendChild(s);
    });
  }
  return loading;
}
