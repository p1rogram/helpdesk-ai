import { useEffect, useState } from 'react';
import type { TicketCard } from '@helpdesk/shared';
import type { ApiClient } from '../lib/api';

const STATE: Record<TicketCard['state'], string> = {
  intake: 'новое',
  clarifying: 'уточнение',
  choosing_category: 'выбор категории',
  solving: 'решение',
  closed: 'решено',
  escalated: 'у специалиста',
};

/** "История обращений" + "возможность вернуться к предыдущему обращению". */
export function HistoryScreen(props: { api: ApiClient; onOpen: (id: string) => void }) {
  const [items, setItems] = useState<TicketCard[] | null>(null);
  useEffect(() => {
    props.api
      .listTickets()
      .then((r) => setItems(r.tickets))
      .catch(() => setItems([]));
  }, [props.api]);

  if (items === null) return <div className="empty">Загрузка…</div>;
  if (!items.length) return <div className="empty">Обращений пока нет.</div>;
  return (
    <div className="list">
      {items.map((t) => (
        <div key={t.id} className="item" onClick={() => props.onOpen(t.id)}>
          <div className="t">{t.summary ?? 'Без описания'}</div>
          <div className="m">
            <span>№{t.id.slice(0, 8).toUpperCase()}</span>
            <span>{t.categoryName ?? '—'}</span>
            <span>{STATE[t.state]}</span>
            {t.rating !== null && <span>{'★'.repeat(t.rating)}</span>}
            <span>{new Date(t.createdAt).toLocaleDateString('ru-RU')}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
