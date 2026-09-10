import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, QuickReply, TicketCard } from '@helpdesk/shared';
import type { ApiClient } from '../lib/api';
import type { PlatformAdapter } from '../lib/platform';
import { Composer } from '../components/Composer';
import { MessageBubble } from '../components/MessageBubble';
import { QuickReplies } from '../components/QuickReplies';
import { RatingStars } from '../components/RatingStars';
import { TicketCardPanel } from '../components/TicketCardPanel';

const NEW_TICKET = '__new';

export function ChatScreen(props: {
  api: ApiClient;
  platform: PlatformAdapter;
  ticketId?: string;
  onTicketChange?: (id: string) => void;
  /** Fired whenever the ticket card changes (state, summary) - lets the sidebar refresh. */
  onTicketUpdate?: () => void;
}) {
  const { api, platform } = props;
  const [ticket, setTicket] = useState<TicketCard | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCard, setShowCard] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (id?: string, fresh = false) => {
      setError(null);
      try {
        const r = id ? await api.getTicket(id) : await api.openTicket(fresh);
        setTicket(r.ticket);
        setMessages(r.messages);
        props.onTicketChange?.(r.ticket.id);
      } catch {
        setError('Не удалось загрузить обращение. Проверьте соединение.');
      }
    },
    [api],
  );

  useEffect(() => {
    void load(props.ticketId);
  }, [load, props.ticketId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  // While a specialist owns the ticket, poll for their replies (a push arrives in Telegram too).
  useEffect(() => {
    if (!ticket || ticket.state !== 'escalated') return;
    const id = ticket.id;
    const timer = setInterval(async () => {
      try {
        const r = await api.getTicket(id);
        setMessages((m) => (r.messages.length !== m.length ? r.messages : m));
        setTicket(r.ticket);
      } catch {
        /* transient */
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [api, ticket?.id, ticket?.state]);

  const send = async (text: string, label?: string) => {
    if (!ticket || busy) return;
    if (text === NEW_TICKET) {
      await load(undefined, true);
      return;
    }
    setBusy(true);
    setError(null);
    platform.haptic('light');
    // Optimistic user bubble (commands show their label).
    setMessages((m) => [
      ...m,
      { id: `tmp-${Date.now()}`, role: 'user', content: label ?? text, createdAt: new Date().toISOString() },
    ]);
    setStreaming('');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      for await (const ev of api.sendMessage(ticket.id, text, ac.signal)) {
        if (ev.type === 'meta') setTicket(ev.ticket);
        else if (ev.type === 'status') setStatus(ev.text);
        else if (ev.type === 'delta') {
          setStatus(null);
          setStreaming((s) => (s ?? '') + ev.text);
        }
        else if (ev.type === 'done') {
          setStreaming(null);
          setMessages((m) => [...m, ev.message]);
          setTicket(ev.ticket);
          props.onTicketUpdate?.();
          platform.haptic(ev.ticket.state === 'escalated' ? 'error' : 'success');
        } else if (ev.type === 'error') {
          setError(ev.message);
        }
      }
    } catch {
      setError('Связь прервалась. Попробуйте отправить сообщение ещё раз.');
    } finally {
      setStreaming(null);
      setStatus(null);
      setBusy(false);
    }
  };

  const last = messages[messages.length - 1];
  const quick: QuickReply[] = !busy && last?.role === 'assistant' && last.quickReplies ? last.quickReplies : [];
  const closed = ticket?.state === 'closed';

  return (
    <>
      {ticket && (
        <div style={{ padding: '8px 12px 0', display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <StateChip ticket={ticket} />
          {ticket.categoryName && <span className="chip">{ticket.categoryName}</span>}
          {ticket.confidence !== null && (
            <span title="Уверенность системы">
              <span className="conf">
                <i style={{ width: `${Math.round(ticket.confidence * 100)}%` }} />
              </span>{' '}
              {Math.round(ticket.confidence * 100)}%
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button className="iconbtn" onClick={() => setShowCard((v) => !v)}>
            {showCard ? 'Скрыть карточку' : 'Карточка'}
          </button>
        </div>
      )}
      {showCard && ticket && <TicketCardPanel ticket={ticket} />}
      <div className="chat">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {streaming !== null && <MessageBubble streaming content={streaming} status={status ?? undefined} />}
        <div ref={bottomRef} />
      </div>
      {error && <div className="error">{error}</div>}
      {ticket?.state === 'closed' && ticket.rating === null && (
        <RatingStars
          onRate={async (r) => {
            const res = await api.rate(ticket.id, r);
            setTicket(res.ticket);
            props.onTicketUpdate?.();
            platform.haptic('success');
          }}
        />
      )}
      <QuickReplies items={quick} onPick={(q) => send(q.value, q.label)} />
      <Composer
        disabled={busy || !ticket || closed}
        placeholder={
          closed
            ? 'Обращение закрыто — нажмите «Новое обращение»'
            : ticket?.state === 'escalated'
              ? 'Написать специалисту…'
              : 'Опишите проблему…'
        }
        onSend={(t) => send(t)}
      />
    </>
  );
}

function StateChip({ ticket }: { ticket: TicketCard }) {
  const map: Record<TicketCard['state'], [string, string]> = {
    intake: ['Новое', ''],
    clarifying: ['Уточнение', 'warn'],
    choosing_category: ['Выбор категории', 'warn'],
    solving: ['Решение', ''],
    offer_escalation: ['Создать заявку?', 'warn'],
    closed: ['Решено', 'ok'],
    escalated: ['У специалиста', 'danger'],
  };
  const [label, cls] = map[ticket.state];
  return <span className={`chip ${cls}`}>{label}</span>;
}
