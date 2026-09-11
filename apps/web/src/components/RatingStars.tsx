import { useState } from 'react';

/**
 * AI: Пять звёзд под закрытым тикетом. После оценки звёзды остаются на экране заполненными, чтобы
 * результат нажатия был виден (сама строка «спасибо» приходит сообщением в чат).
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
