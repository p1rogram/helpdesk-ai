import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, TicketCard } from '@helpdesk/shared';
import type { ApiClient } from '../lib/api';
import { MessageBubble } from '../components/MessageBubble';
import { TicketCardPanel } from '../components/TicketCardPanel';

type QueueItem = TicketCard & {
  user: { displayName: string; platform: string };
  lastMessageAt: string | null;
  unanswered: boolean;
  group: 0 | 1 | 2;
};

const GROUP_TITLE: Record<0 | 1 | 2, string> = {
  0: 'В работе — вы отвечаете',
  1: 'Ждут первого ответа',
  2: 'Закрытые',
};

/**
 * Built-in specialist console: live queue of escalated tickets (grouped), full transcript + card,
 * reply into the user's chat, hand back to the assistant, close as resolved. ADMIN_USERS only.
 */
export function OperatorScreen(props: { api: ApiClient }) {
  const { api } = props;
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [open, setOpen] = useState<{
    ticket: TicketCard;
    user: { displayName: string } | null;
    messages: ChatMessage[];
  } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const [live, setLive] = useState(false);
  const openIdRef = useRef<string | null>(null);
  openIdRef.current = open?.ticket.id ?? null;

  const loadQueue = useCallback(
    () =>
      api
        .operatorTickets()
        .then((r) => setQueue(r.tickets))
        .catch(() => setQueue((prev) => prev ?? [])),
    [api],
  );
  const loadTicket = useCallback((id: string) => api.operatorTicket(id).then(setOpen).catch(() => {}), [api]);

  // Realtime: the server pushes a hint whenever this tenant's queue changes.
  useEffect(() => {
    void loadQueue();
    const ac = new AbortController();
    setLive(true);
    api.operatorStream((ticketId) => {
      void loadQueue();
      if (ticketId && ticketId === openIdRef.current) void loadTicket(ticketId);
    }, ac.signal);
    return () => {
      ac.abort();
      setLive(false);
    };
  }, [api, loadQueue, loadTicket]);

  if (!open) {
    if (queue === null) return <div className="empty">Загрузка…</div>;
    if (!queue.length) return <div className="empty">Очередь пуста — все обращения обработаны.</div>;
    let lastGroup: number | null = null;
    return (
      <div className="list">
        <div className="queue-head">
          Обращений: {queue.length}
          <span className={`live-dot${live ? ' on' : ''}`} title={live ? 'Обновляется в реальном времени' : 'Нет связи'} />
        </div>
        {queue.map((t) => {
          const header = t.group !== lastGroup ? GROUP_TITLE[t.group] : null;
          lastGroup = t.group;
          return (
            <div key={t.id}>
              {header && <div className="group-title">{header}</div>}
              <div className={`item${t.group === 2 ? ' muted' : ''}`} onClick={() => loadTicket(t.id)}>
                <div className="t">
                  {t.group === 1 && (
                    <span className="chip danger" style={{ marginRight: 6 }}>
                      ждёт ответа
                    </span>
                  )}
                  {t.group === 0 && t.unanswered && (
                    <span className="chip warn" style={{ marginRight: 6 }}>
                      новое сообщение
                    </span>
                  )}
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
            </div>
          );
        })}
      </div>
    );
  }

  const act = async (fn: () => Promise<unknown>, back = false) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      if (back) setOpen(null);
      else await loadTicket(open.ticket.id);
      await loadQueue();
    } finally {
      setBusy(false);
    }
  };

  const closed = open.ticket.state === 'closed';
  const withAssistant = open.ticket.handledBy === 'ai';

  return (
    <>
      <div style={{ padding: '8px 12px 0', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, flexWrap: 'wrap' }}>
        <button className="iconbtn" onClick={() => setOpen(null)}>
          Назад к очереди
        </button>
        <span style={{ flex: 1, minWidth: 120 }}>
          {open.user?.displayName ?? '—'} · №{open.ticket.externalId ?? open.ticket.id.slice(0, 8).toUpperCase()}
        </span>
        <button className="iconbtn" onClick={() => setShowCard((v) => !v)}>
          {showCard ? 'Скрыть карточку' : 'Карточка'}
        </button>
        {!closed && !withAssistant && (
          <button
            className="iconbtn"
            disabled={busy}
            title="Вернуть обращение помощнику: специалист не нужен, помощник продолжит сам"
            onClick={() => act(() => api.operatorHandback(open.ticket.id), true)}
          >
            Передать помощнику
          </button>
        )}
        {!closed && (
          <button className="iconbtn active" disabled={busy} onClick={() => act(() => api.operatorClose(open.ticket.id), true)}>
            Закрыть как решённое
          </button>
        )}
      </div>
      {withAssistant && !closed && (
        <div className="notice">Обращение передано помощнику — он снова ведёт диалог и не будет передавать его специалисту.</div>
      )}
      {showCard && <TicketCardPanel ticket={open.ticket} />}
      <div className="chat">
        {open.messages.map((m) => (
          <MessageBubble key={m.id} message={m} perspective="operator" />
        ))}
      </div>
      {!closed && (
        <div className="composer">
          <textarea
            rows={2}
            value={text}
            placeholder="Ответ пользователю (уйдёт в чат и push в Telegram)…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) {
                void act(async () => {
                  await api.operatorReply(open.ticket.id, text.trim());
                  setText('');
                });
              }
            }}
          />
          <button
            disabled={busy || !text.trim()}
            onClick={() =>
              act(async () => {
                await api.operatorReply(open.ticket.id, text.trim());
                setText('');
              })
            }
          >
            ➤
          </button>
        </div>
      )}
    </>
  );
}
