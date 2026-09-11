import { useEffect, type RefObject } from 'react';

/** AI: Elements that scroll sideways themselves - a swipe started there must not change the tab. */
const HORIZONTAL = '.toolbar, .filters, .quick, textarea, input, .steplist';

/**
 * AI: Horizontal swipe between tabs. A gesture counts only when it is clearly sideways
 * (twice as much X as Y, past a threshold), so vertical scrolling inside a screen is untouched.
 */
export function useSwipeNavigation(
  ref: RefObject<HTMLElement | null>,
  onSwipe: (direction: 1 | -1) => void,
  enabled = true,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length > 1) return;
      const target = e.target as HTMLElement | null;
      tracking = !target?.closest(HORIZONTAL);
      startX = t.clientX;
      startY = t.clientY;
    };

    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;
      onSwipe(dx < 0 ? 1 : -1);
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
    };
  }, [ref, onSwipe, enabled]);
}
