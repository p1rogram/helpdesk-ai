import { useEffect, useMemo, useState } from 'react';
import type { TicketCard } from '@helpdesk/shared';
import type { ApiClient } from '../lib/api';
import { Icon, categoryVisual } from '../components/Icon';
import { SkeletonList } from '../components/Skeleton';

type Filter = 'all' | 'resolved' | 'escalated';

const STATE_CHIP: Record<TicketCard['state'], { label: string; cls: string }> = {
  intake: { label: 'Новое', cls: 'accent' },
  clarifying: { label: 'Уточнение', cls: 'warn' },
  choosing_category: { label: 'Выбор категории', cls: 'warn' },
  solving: { label: 'Решение', cls: 'accent' },
  offer_escalation: { label: 'Нужно решение', cls: 'warn' },
  closed: { label: 'Решено', cls: 'ok' },
  escalated: { label: 'У специалиста', cls: 'danger' },
};

/** AI: История обращений: фильтры, карточки с иконкой категории и статусом, пустое состояние. */
export function HistoryScreen(props: {
  api: ApiClient;
  onOpen: (id: string) => void;
  onNew?: () => void;
  refreshKey?: number;
  activeId?: string;
  /** AI: The pane stays mounted, so data is re-read when the tab becomes visible again. */
  active?: boolean;
}) {
  const [items, setItems] = useState<TicketCard[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const active = props.active ?? true;
  useEffect(() => {
    if (!active) return;
    props.api
      .listTickets()
      .then((r) => setItems(r.tickets))
      .catch(() => setItems((prev) => prev ?? []));
  }, [props.api, props.refreshKey, active]);

  const counts = useMemo(() => {
    const all = items ?? [];
    return {
      all: all.length,
      resolved: all.filter((t) => t.resolved).length,
      escalated: all.filter((t) => t.escalated || t.state === 'escalated').length,
    };
  }, [items]);

  if (items === null) return <SkeletonList rows={4} />;

  if (!items.length) {
    return (
      <div className="empty">
        <span className="art">
          <Icon name="history" size={34} />
        </span>
        <div className="lead">Пока у вас нет обращений</div>
        <div>Здесь будут отображаться ваши запросы в техподдержку</div>
        {props.onNew && (
          <button className="btn" style={{ marginTop: 12 }} onClick={props.onNew}>
            Задать вопрос
          </button>
        )}
      </div>
    );
  }

  const shown = items.filter((t) =>
    filter === 'all' ? true : filter === 'resolved' ? t.resolved : t.escalated || t.state === 'escalated',
  );

  return (
    <>
      <div className="filters">
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
          Все {counts.all}
        </button>
        <button className={filter === 'resolved' ? 'active' : ''} onClick={() => setFilter('resolved')}>
          Решённые {counts.resolved}
        </button>
        <button className={filter === 'escalated' ? 'active' : ''} onClick={() => setFilter('escalated')}>
          Переданные {counts.escalated}
        </button>
      </div>
      <div className="list">
        {shown.map((t) => {
          const v = categoryVisual(t.categoryId);
          const chip = STATE_CHIP[t.state];
          return (
            <div
              key={t.id}
              className={`item${t.id === props.activeId ? ' active' : ''}`}
              onClick={() => props.onOpen(t.id)}
            >
              <span className={`tile-ico ${v.tone}`}>
                <Icon name={v.icon} size={19} />
              </span>
              <div className="body">
                <div className="t">{t.categoryName ?? 'Обращение'}</div>
                <div className="status-row">
                  <span className={`chip ${chip.cls}`}>{chip.label}</span>
                  {t.rating !== null && (
                    <span className="rating" title={`Оценка: ${t.rating} из 5`}>
                      {'★'.repeat(t.rating)}
                      <span className="rest">{'★'.repeat(5 - t.rating)}</span>
                    </span>
                  )}
                </div>
                <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 4 }}>{t.summary ?? 'Без описания'}</div>
                <div className="m">
                  <span className="id">TPU-{(t.externalId ?? t.id.slice(0, 6)).toUpperCase()}</span>
                  <span>
                    {new Date(t.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })},{' '}
                    {new Date(t.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        {!shown.length && <div className="empty">В этой группе пока пусто.</div>}
      </div>
    </>
  );
}
