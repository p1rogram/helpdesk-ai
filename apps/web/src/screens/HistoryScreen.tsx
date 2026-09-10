import { useEffect, useState } from 'react';
import type { TicketCard } from '@helpdesk/shared';
import type { ApiClient } from '../lib/api';

const STATE: Record<TicketCard['state'], string> = {
  intake: 'новое',
  clarifying: 'уточнение',
  choosing_category: 'выбор категории',
  solving: 'решение',
  offer_escalation: 'ожидает решения',
  closed: 'решено',
  escalated: 'у специалиста',
};

/** "История обращений" + "возможность вернуться к предыдущему обращению". */
export function HistoryScreen(props: {
  api: ApiClient;
  onOpen: (id: string) => void;
  compact?: boolean;
  /** Bump to re-fetch (the sidebar follows the live chat). */
  refreshKey?: number;
  activeId?: string;
}) {
  const [items, setItems] = useState<TicketCard[] | null>(null);
  useEffect(() => {
    props.api
      .listTickets()
      .then((r) => setItems(r.tickets))
      .catch(() => setItems((prev) => prev ?? []));
  }, [props.api, props.refreshKey]);

  if (items === null) return <div className="empty">Загрузка…</div>;
  if (!items.length) return <div className="empty">{props.compact ? 'История пуста' : 'Обращений пока нет.'}</div>;
  return (
    <div className={`list${props.compact ? ' compact' : ''}`}>
      {props.compact && <div className="side-title">История</div>}
      {items.map((t) => (
        <div key={t.id} className={`item${t.id === props.activeId ? ' active' : ''}`} onClick={() => props.onOpen(t.id)}>
          <div className="t">{t.summary ?? 'Без описания'}</div>
          <div className="m">
            <span>№{t.externalId ?? t.id.slice(0, 8).toUpperCase()}</span>
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
