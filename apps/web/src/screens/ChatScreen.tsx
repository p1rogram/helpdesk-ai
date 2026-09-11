import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, QuickReply, TicketCard } from '@helpdesk/shared';
import { ApiError, type ApiClient } from '../lib/api';
import { playMessage } from '../lib/sound';
import type { PlatformAdapter } from '../lib/platform';
import { Composer } from '../components/Composer';
import { MessageBubble } from '../components/MessageBubble';
import { QuickReplies } from '../components/QuickReplies';
import { RatingStars } from '../components/RatingStars';
import { TicketCardPanel } from '../components/TicketCardPanel';
import { CategoryBadge } from '../components/CategoryBadge';

const NEW_TICKET = '__new';

export function ChatScreen(props: {
  api: ApiClient;
  platform: PlatformAdapter;
  ticketId?: string;
  onTicketChange?: (id: string) => void;
  /**
   * AI: Срабатывает при любом изменении карточки тикета (состояние, суть) - даёт боковой панели
   * обновиться.
   */
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
  // AI: Id тикета, который реально на экране. Проп может отставать на один рендер, когда новый чат
  // создаётся здесь, и без этой защиты эффект ниже перезагрузил бы предыдущий тикет.
  const loadedRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (id?: string, fresh = false) => {
      setError(null);
      try {
        let r;
        try {
          r = id ? await api.getTicket(id) : await api.openTicket(fresh);
        } catch (err) {
          // AI: Запомненный тикет пропал (очищенная база, другой аккаунт) - открываем текущий
          // вместо ошибки на устаревший id.
          if (!(id && err instanceof ApiError && err.status === 404)) throw err;
          r = await api.openTicket(false);
        }
        loadedRef.current = r.ticket.id;
        setTicket(r.ticket);
        setMessages(r.messages);
        setStatus(null);
        props.onTicketChange?.(r.ticket.id);
      } catch {
        setError('Не удалось загрузить обращение. Проверьте соединение.');
      }
    },
    [api],
  );

  useEffect(() => {
    if (props.ticketId && props.ticketId === loadedRef.current) return;
    void load(props.ticketId);
  }, [load, props.ticketId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  // AI: Пока тикет у специалиста, опрашиваем его ответы (push приходит и в Telegram).
  useEffect(() => {
    if (!ticket || ticket.state !== 'escalated') return;
    const id = ticket.id;
    const timer = setInterval(async () => {
      try {
        const r = await api.getTicket(id);
        setMessages((m) => {
          if (r.messages.length === m.length) return m;
          // AI: Новое сообщение от специалиста - тот же звук, что и при ответе помощника.
          playMessage();
          return r.messages;
        });
        setTicket(r.ticket);
      } catch {
        /* временная ошибка */
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [api, ticket?.id, ticket?.state]);

  const send = async (text: string, label?: string) => {
    if (busy) return;
    // AI: Новый чат можно начать всегда, даже до загрузки первого тикета.
    if (!ticket && text !== NEW_TICKET) return;
    if (text === NEW_TICKET) {
      setBusy(true);
      try {
        await load(undefined, true);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!ticket) return;
    const ticketId = ticket.id;
    setBusy(true);
    setError(null);
    platform.haptic('light');
    // AI: Оптимистичный пузырь пользователя (команды показывают свою подпись).
    setMessages((m) => [
      ...m,
      {
        id: `tmp-${Date.now()}`,
        role: 'user',
        content: label ?? text,
        createdAt: new Date().toISOString(),
      },
    ]);
    setStreaming('');
    playMessage();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      for await (const ev of api.sendMessage(ticketId, text, ac.signal)) {
        if (ev.type === 'meta') {
          // AI: Карточка изменилась посреди ответа (категория, суть): список истории уже может
          // показать тикет, не дожидаясь полного ответа.
          setTicket(ev.ticket);
          props.onTicketUpdate?.();
        } else if (ev.type === 'ack') {
          // AI: Чатом владеет специалист: сообщение доставлено, помощник молчит.
          setStreaming(null);
          setStatus(null);
          setTicket(ev.ticket);
        } else if (ev.type === 'status') setStatus(ev.text);
        else if (ev.type === 'delta') {
          setStatus(null);
          setStreaming((s) => (s ?? '') + ev.text);
        } else if (ev.type === 'done') {
          setStreaming(null);
          playMessage();
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

  // AI: "Закрыть обращение" from the bar under the chat: same effect as the chat command, one
  // round-trip, no streaming. Asks first - the specialist gets a notification.
  const closeTicket = async () => {
    if (!ticket || busy) return;
    if (!(await platform.confirm('Закрыть обращение? Специалист получит уведомление.'))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.closeTicket(ticket.id);
      setMessages((m) => [
        ...m,
        {
          id: `tmp-${Date.now()}`,
          role: 'user',
          content: 'Закрыть обращение',
          createdAt: new Date().toISOString(),
        },
        res.message,
      ]);
      setTicket(res.ticket);
      props.onTicketUpdate?.();
      platform.haptic('success');
    } catch {
      setError('Не удалось закрыть обращение. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };

  const last = messages[messages.length - 1];
  const quick: QuickReply[] =
    !busy && last?.role === 'assistant' && last.quickReplies ? last.quickReplies : [];
  const closed = ticket?.state === 'closed';

  return (
    <>
      {ticket && (
        <div className="toolbar three">
          <button className="pill-btn accent" disabled={busy} onClick={() => send(NEW_TICKET)}>
            Новый чат
          </button>
          <div className="centre">
            {ticket.categoryName ? (
              <CategoryBadge
                categoryId={ticket.categoryId}
                name={ticket.categoryName}
                confidence={ticket.confidence}
              />
            ) : (
              <StateChip ticket={ticket} />
            )}
          </div>
          <button className="pill-btn" onClick={() => setShowCard((v) => !v)}>
            {showCard ? 'Скрыть' : 'Карточка'}
          </button>
        </div>
      )}
      {showCard && ticket && <TicketCardPanel ticket={ticket} />}
      <div className="chat">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {streaming !== null && (
          <MessageBubble streaming content={streaming} status={status ?? undefined} />
        )}
        <div ref={bottomRef} />
      </div>
      {error && <div className="error">{error}</div>}
      {ticket?.state === 'closed' && ticket.closedBy !== 'user' && (
        <RatingStars
          value={ticket.rating}
          onRate={async (r) => {
            try {
              const res = await api.rate(ticket.id, r);
              setMessages((m) => [...m, res.message]);
              setTicket(res.ticket);
              props.onTicketUpdate?.();
              platform.haptic('success');
            } catch {
              setError('Не удалось сохранить оценку. Попробуйте ещё раз.');
            }
          }}
        />
      )}
      {ticket?.state === 'escalated' && (
        <div className="escalated-bar">
          <span>Обращение у специалиста</span>
          <button className="pill-btn" disabled={busy} onClick={() => void closeTicket()}>
            Закрыть обращение
          </button>
        </div>
      )}
      <QuickReplies items={quick} onPick={(q) => send(q.value, q.label)} />
      <Composer
        disabled={busy || !ticket || closed}
        placeholder={
          closed
            ? 'Обращение закрыто'
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
    intake: ['Новое', 'accent'],
    clarifying: ['Уточнение', 'warn'],
    choosing_category: ['Выбор категории', 'warn'],
    solving: ['Решение', 'accent'],
    offer_escalation: ['Создать заявку?', 'warn'],
    closed: ['Решено', 'ok'],
    escalated: ['У специалиста', 'danger'],
  };
  const [label, cls] =
    ticket.state === 'closed' && ticket.closedBy === 'user'
      ? ['Закрыто', 'muted']
      : map[ticket.state];
  return <span className={`chip ${cls}`}>{label}</span>;
}
