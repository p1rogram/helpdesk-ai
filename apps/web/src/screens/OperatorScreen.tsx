import { useCallback, useEffect, useState } from 'react';
import type { ChatMessage, TicketCard } from '@helpdesk/shared';
import type { ApiClient } from '../lib/api';
import { MessageBubble } from '../components/MessageBubble';
import { TicketCardPanel } from '../components/TicketCardPanel';

type QueueItem = TicketCard & { user: { displayName: string; platform: string }; lastMessageAt: string | null; unanswered: boolean };

/**
 * Built-in specialist console: queue of escalated tickets, full transcript + card, reply into
 * the user's chat (push to the messenger), close as resolved. Visible only to ADMIN_USERS.
 */
export function OperatorScreen(props: { api: ApiClient }) {
  const { api } = props;
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [open, setOpen] = useState<{ ticket: TicketCard; user: { displayName: string } | null; messages: ChatMessage[] } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [showCard, setShowCard] = useState(false);

  const loadQueue = useCallback(() => api.operatorTickets().then((r) => setQueue(r.tickets)).catch(() => setQueue([])), [api]);
  const loadTicket = useCallback((id: string) => api.operatorTicket(id).then(setOpen).catch(() => {}), [api]);

  useEffect(() => {
    void loadQueue();
    const t = setInterval(() => {
      void loadQueue();
      if (open) void loadTicket(open.ticket.id);
    }, 5000);
    return () => clearInterval(t);
  }, [loadQueue, loadTicket, open?.ticket.id]);

  if (!open) {
    if (queue === null) return <div className="empty">Загрузка…</div>;
    if (!queue.length) return <div className="empty">Очередь пуста — все обращения обработаны.</div>;
    return (
      <div className="list">
        {queue.map((t) => (
          <div key={t.id} className="item" onClick={() => loadTicket(t.id)}>
            <div className="t">
              {t.unanswered && <span className="chip danger" style={{ marginRight: 6 }}>ждёт ответа</span>}
              {t.summary ?? 'Без описания'}
            </div>
            <div className="m">
              <span>№{t.externalId ?? t.id.slice(0, 8).toUpperCase()}</span>
              <span>{t.user.displayName}</span>
              <span>{t.categoryName ?? '—'}</span>
              <span>приоритет: {t.priority}</span>
              <span>{new Date(t.lastMessageAt ?? t.updatedAt).toLocaleString('ru-RU')}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  const send = async () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy(true);
    try {
      await api.operatorReply(open.ticket.id, msg);
      setText('');
      await loadTicket(open.ticket.id);
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.operatorClose(open.ticket.id);
      setOpen(null);
      await loadQueue();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ padding: '8px 12px 0', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <button className="iconbtn" onClick={() => setOpen(null)}>
          Назад к очереди
        </button>
        <span style={{ flex: 1 }}>
          {open.user?.displayName ?? '—'} · №{open.ticket.externalId ?? open.ticket.id.slice(0, 8).toUpperCase()}
        </span>
        <button className="iconbtn" onClick={() => setShowCard((v) => !v)}>
          {showCard ? 'Скрыть карточку' : 'Карточка'}
        </button>
        {open.ticket.state !== 'closed' && (
          <button className="iconbtn active" disabled={busy} onClick={close}>
            Закрыть как решённое
          </button>
        )}
      </div>
      {showCard && <TicketCardPanel ticket={open.ticket} />}
      <div className="chat">
        {open.messages.map((m) => (
          <MessageBubble key={m.id} message={m} perspective="operator" />
        ))}
      </div>
      {open.ticket.state !== 'closed' && (
        <div className="composer">
          <textarea
            rows={2}
            value={text}
            placeholder="Ответ пользователю (уйдёт в чат и push в Telegram)…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
            }}
          />
          <button disabled={busy || !text.trim()} onClick={send}>
            ➤
          </button>
        </div>
      )}
    </>
  );
}
