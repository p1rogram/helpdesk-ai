import { useState } from 'react';

/**
 * AI: Five stars under a closed ticket. Once rated the stars stay on screen, filled, so the result
 * of the click is visible (the "thank you" line itself arrives as a chat message).
 */
export function RatingStars(props: {
  value: number | null;
  onRate: (rating: number) => Promise<void>;
}) {
  const [hover, setHover] = useState(0);
  const [busy, setBusy] = useState(false);
  const rated = props.value !== null;
  const lit = rated ? props.value! : hover;
  return (
    <div className={`stars${rated ? ' rated' : ''}`} aria-label="Оценка ответа">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={n <= lit ? '' : 'off'}
          disabled={rated || busy}
          onMouseEnter={() => !rated && setHover(n)}
          onMouseLeave={() => setHover(0)}
          onClick={async () => {
            setBusy(true);
            try {
              await props.onRate(n);
            } finally {
              setBusy(false);
            }
          }}
        >
          ★
        </button>
      ))}
      {rated && <span className="sub">Ваша оценка: {props.value} из 5</span>}
    </div>
  );
}
