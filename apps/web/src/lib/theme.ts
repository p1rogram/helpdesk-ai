export type ThemeMode = 'auto' | 'light' | 'dark';

const KEY = 'helpdesk.theme';

/**
 * AI: Управление темой. `auto` следует за хостом (цветовая схема Telegram в Mini App, системная
 * настройка в браузере); `light` / `dark` - явный выбор пользователя, переживает перезагрузку.
 */
export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    if (mode === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* хранилище недоступно */
  }
}

/** AI: Разрешает `auto` относительно хоста и записывает результат в <html data-theme>. */
export function applyTheme(mode: ThemeMode, hostPrefersDark: boolean): 'light' | 'dark' {
  const resolved = mode === 'auto' ? (hostPrefersDark ? 'dark' : 'light') : mode;
  // AI: color-scheme объявлен в CSS для этого атрибута, поэтому элементы браузера (полосы
  // прокрутки, элементы форм) перекрашиваются в том же кадре, что и токены, а не на такт позже.
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

/** AI: Вызывает колбэк при смене системной цветовой схемы (важно только в режиме `auto`). */
export function watchSystemTheme(onChange: (dark: boolean) => void): () => void {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mq) return () => {};
  const handler = (e: MediaQueryListEvent) => onChange(e.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
