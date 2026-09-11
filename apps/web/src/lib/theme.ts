export type ThemeMode = 'auto' | 'light' | 'dark';

const KEY = 'helpdesk.theme';

/**
 * AI: Theme control. `auto` follows the host (Telegram colour scheme in a Mini App, the OS setting in a
 * browser); `light` / `dark` are explicit user choices and survive reloads.
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
    /* storage unavailable */
  }
}

/** AI: Resolves `auto` against the host and writes the result to <html data-theme>. */
export function applyTheme(mode: ThemeMode, hostPrefersDark: boolean): 'light' | 'dark' {
  const resolved = mode === 'auto' ? (hostPrefersDark ? 'dark' : 'light') : mode;
  // AI: colour-scheme is declared in CSS for this attribute, so browser chrome (scrollbars, form
  // controls) repaints in the same frame as the tokens instead of a beat later.
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

/** AI: Calls back when the OS colour scheme changes (only relevant while the mode is `auto`). */
export function watchSystemTheme(onChange: (dark: boolean) => void): () => void {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mq) return () => {};
  const handler = (e: MediaQueryListEvent) => onChange(e.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
