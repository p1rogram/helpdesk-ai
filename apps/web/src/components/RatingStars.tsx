import { useState } from 'react';

export function RatingStars(props: { onRate: (rating: number) => Promise<void> }) {
  const [hover, setHover] = useState(0);
  const [done, setDone] = useState(false);
  if (done) return <div className="sub" style={{ padding: '6px 12px', color: 'var(--muted)' }}>Спасибо за оценку!</div>;
  return (
    <div className="stars" aria-label="Оценка ответа">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={n <= hover ? '' : 'off'}
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          onClick={async () => {
            await props.onRate(n);
            setDone(true);
          }}
        >
          ★
        </button>
      ))}
    </div>
  );
}
