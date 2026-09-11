import { useEffect, type RefObject } from 'react';

/**
 * AI: Элементы, которые сами прокручиваются вбок - свайп, начатый в них, не должен менять вкладку.
 */
const HORIZONTAL = '.toolbar, .filters, .quick, textarea, input, .steplist';

/**
 * AI: Горизонтальный свайп между вкладками. Жест засчитывается, только если он явно боковой (по X
 * вдвое больше, чем по Y, и больше порога), поэтому вертикальная прокрутка внутри экрана не
 * затрагивается.
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
