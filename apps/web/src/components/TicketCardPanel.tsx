import type { TicketCard } from '@helpdesk/shared';

const PRIORITY = { low: 'низкий', normal: 'обычный', high: 'высокий' } as const;
const TONE = { neutral: 'спокойный', frustrated: 'раздражён', abusive: 'грубый' } as const;

/** "Автоматическое формирование карточки обращения" - what a specialist receives. */
export function TicketCardPanel({ ticket }: { ticket: TicketCard }) {
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <span className="k">№</span>
      <span>{ticket.id.slice(0, 8).toUpperCase()}</span>
      <span className="k">Проблема</span>
      <span>{ticket.summary ?? '—'}</span>
      <span className="k">Категория</span>
      <span>{ticket.categoryName ?? '—'}</span>
      <span className="k">Приоритет</span>
      <span>{PRIORITY[ticket.priority]}</span>
      <span className="k">Уверенность</span>
      <span>{ticket.confidence === null ? '—' : `${Math.round(ticket.confidence * 100)}%`}</span>
      <span className="k">Тон</span>
      <span>{TONE[ticket.tone]}</span>
      {Object.entries(ticket.fields).map(([k, v]) => (
        <FieldRow key={k} k={k} v={v} />
      ))}
      <span className="k">Статья</span>
      <span>{ticket.articleTitle ?? '—'}</span>
      <span className="k">Статус</span>
      <span>{ticket.resolved ? 'решено' : ticket.escalated ? 'у специалиста' : 'в работе'}</span>
      <span className="k">Создано</span>
      <span>{new Date(ticket.createdAt).toLocaleString('ru-RU')}</span>
    </div>
  );
}

function FieldRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className="k">{k}</span>
      <span>{v}</span>
    </>
  );
}
