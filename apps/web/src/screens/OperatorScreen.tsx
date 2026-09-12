import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, TicketCard } from '@helpdesk/shared';
import type { ApiClient, OperatorStats, OperatorStatsPeriod } from '../lib/api';
import { MessageBubble } from '../components/MessageBubble';
import { TicketCardPanel } from '../components/TicketCardPanel';
import { Icon, categoryVisual } from '../components/Icon';
import { SkeletonList } from '../components/Skeleton';
import { playSend } from '../lib/sound';

type Group = 0 | 1 | 2 | 3 | 4;
type QueueItem = TicketCard & {
  user: { displayName: string; platform: string };
  lastMessageAt: string | null;
  unanswered: boolean;
  group: Group;
};
type OpenTicket = {
  ticket: TicketCard;
  user: { displayName: string } | null;
  messages: ChatMessage[];
  tried: string[];
  notes: string;
  escalationReason: string | null;
};

const GROUP_TITLE: Record<Group, string> = {
  0: 'Мои обращения',
  1: 'Ждут специалиста',
  2: 'В работе у коллег',
  3: 'Закрыты специалистами',
  4: 'Завершены без специалиста',
};

/** AI: Шаблоны быстрых ответов: подставляются в поле, можно править перед отправкой. */
const TEMPLATES: Array<{ label: string; text: string }> = [
  {
    label: 'Взял в работу',
    text: 'Здравствуйте! Взял ваше обращение в работу, разбираюсь. Напишу, как только будет результат.',
  },
  { label: 'Нужны детали', text: 'Чтобы помочь быстрее, уточните, пожалуйста: ' },
  {
    label: 'Передал в подразделение',
    text: 'Передал ваш вопрос в профильное подразделение. Ориентировочный срок ответа - 1–2 рабочих дня.',
  },
  {
    label: 'Решено?',
    text: 'Проверьте, пожалуйста, всё ли теперь работает. Если да - я закрою обращение.',
  },
  {
    label: 'Закрываю',
    text: 'Рад, что помогло. Закрываю обращение; если проблема повторится - создайте новое, и я подключусь.',
  },
];

const REASON: Record<string, string> = {
  user_request: 'пользователь попросил специалиста',
  no_solution: 'помощник не нашёл решения',
  solution_failed: 'предложенное решение не помогло',
  article_requires_specialist: 'по регламенту оформляет специалист',
  low_confidence: 'помощник не понял проблему',
};

/**
 * AI: Встроенная консоль специалиста: сводка за день, живая очередь с группами и фильтрами,
 * переписка с карточкой и рабочим контекстом (что помощник уже предлагал), заметки, шаблоны ответов,
 * «взять себе», возврат помощнику, закрытие. Только операторы.
 */
export function OperatorScreen(props: { api: ApiClient }) {
  const { api } = props;
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [me, setMe] = useState('');
  const [stats, setStats] = useState<OperatorStats | null>(null);
  const [open, setOpen] = useState<OpenTicket | null>(null);
  const [text, setText] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const [live, setLive] = useState(false);
  const [filterCat, setFilterCat] = useState('');
  const [filterText, setFilterText] = useState('');
  const openIdRef = useRef<string | null>(null);
  openIdRef.current = open?.ticket.id ?? null;

  const loadQueue = useCallback(
    () =>
      Promise.all([api.operatorTickets(), api.operatorStats()])
        .then(([q, s]) => {
          setQueue(q.tickets as QueueItem[]);
          setMe(q.me);
          setStats(s);
        })
        .catch(() => setQueue((prev) => prev ?? [])),
    [api],
  );
  const loadTicket = useCallback(
    (id: string) =>
      api
        .operatorTicket(id)
        .then((t) => {
          setOpen(t as OpenTicket);
          setNotes((t as OpenTicket).notes ?? '');
        })
        .catch(() => {}),
    [api],
  );

  useEffect(() => {
    void loadQueue();
    const ac = new AbortController();
    setLive(true);
    api.operatorStream((ticketId) => {
      void loadQueue();
      if (ticketId && ticketId === openIdRef.current) void loadTicket(ticketId);
    }, ac.signal);
    // AI: Страховка для прокси, которые полностью блокируют стримы: медленный опрос, пока вкладка
    // видима.
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void loadQueue();
    }, 30_000);
    return () => {
      ac.abort();
      clearInterval(poll);
      setLive(false);
    };
  }, [api, loadQueue, loadTicket]);

  const categories = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of queue ?? [])
      if (t.categoryId && t.categoryName) m.set(t.categoryId, t.categoryName);
    return [...m.entries()];
  }, [queue]);

  if (!open) {
    if (queue === null) return <SkeletonList rows={4} />;
    const needle = filterText.trim().toLowerCase();
    const shown = queue.filter(
      (t) =>
        (!filterCat || t.categoryId === filterCat) &&
        (!needle ||
          [t.summary, t.externalId, t.user.displayName, ...Object.values(t.fields)]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(needle))),
    );
    let lastGroup: number | null = null;
    return (
      <div className="list">
        {stats && <StatsStrip stats={stats} />}
        <div className="queue-head">
          Обращений: {shown.length}
          {me && <span style={{ color: 'var(--muted)' }}> · вы: {me}</span>}
          <span
            className={`dot${live ? '' : ' off'}`}
            title={live ? 'Обновляется в реальном времени' : 'Нет связи'}
          />
        </div>
        <div className="op-filters">
          <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
            <option value="">Все категории</option>
            {categories.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <input
            placeholder="Поиск: суть, номер, корпус, общежитие…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
        </div>
        {!shown.length && <div className="empty">Ничего не найдено.</div>}
        {shown.map((t) => {
          const header = t.group !== lastGroup ? GROUP_TITLE[t.group] : null;
          lastGroup = t.group;
          return (
            <div key={t.id}>
              {header && <div className="group-title">{header}</div>}
              <div
                className={`item${t.group >= 3 ? ' muted' : ''}`}
                onClick={() => loadTicket(t.id)}
              >
                <span className={`tile-ico ${categoryVisual(t.categoryId).tone}`}>
                  <Icon name={categoryVisual(t.categoryId).icon} size={19} />
                </span>
                <div className="body">
                  <div className="t">
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.summary ?? 'Без описания'}
                    </span>
                    <QueueChip t={t} />
                  </div>
                  <div className="m">
                    <span className="id">№{t.externalId ?? t.id.slice(0, 8).toUpperCase()}</span>
                    <span>{t.user.displayName}</span>
                    <span>{t.categoryName ?? '-'}</span>
                    {t.fields.building && <span>{t.fields.building}</span>}
                    <span>приоритет: {t.priority}</span>
                    <span>{new Date(t.lastMessageAt ?? t.updatedAt).toLocaleString('ru-RU')}</span>
                  </div>
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
  const withAssistant = open.ticket.handledBy === 'ai' && !closed;
  const mine = open.ticket.assignedTo === me;

  return (
    <>
      <div className="op-head">
        <button className="pill-btn" onClick={() => setOpen(null)}>
          Назад к очереди
        </button>
        <span style={{ flex: 1, minWidth: 120 }}>
          {open.user?.displayName ?? '-'} · №
          {open.ticket.externalId ?? open.ticket.id.slice(0, 8).toUpperCase()}
          {open.ticket.assignedTo && (
            <span className={`chip ${mine ? 'ok' : 'warn'}`} style={{ marginLeft: 8 }}>
              {mine ? 'у вас' : `у ${open.ticket.assignedTo}`}
            </span>
          )}
        </span>
        <button className="pill-btn" onClick={() => setShowCard((v) => !v)}>
          {showCard ? 'Скрыть карточку' : 'Карточка'}
        </button>
        {!closed && !withAssistant && !mine && (
          <button
            className="pill-btn"
            disabled={busy}
            onClick={() => act(() => api.operatorAssign(open.ticket.id))}
          >
            Взять себе
          </button>
        )}
        {!closed && !withAssistant && (
          <button
            className="pill-btn"
            disabled={busy}
            title="Вернуть обращение помощнику: специалист не нужен, помощник продолжит сам"
            onClick={() => act(() => api.operatorHandback(open.ticket.id), true)}
          >
            Передать помощнику
          </button>
        )}
        {!closed && (
          <button
            className="pill-btn active"
            disabled={busy}
            onClick={() => act(() => api.operatorClose(open.ticket.id), true)}
          >
            Закрыть как решённое
          </button>
        )}
      </div>

      {/* AI: Рабочий контекст: почему передано и что помощник уже пробовал. */}
      <div className="op-context">
        <div>
          <b>Почему у специалиста:</b>{' '}
          {open.escalationReason ? (REASON[open.escalationReason] ?? open.escalationReason) : '-'}
        </div>
        {open.tried.length > 0 && (
          <div>
            <b>Помощник уже предлагал:</b> {open.tried.join('; ')}
            {open.escalationReason === 'solution_failed' ? ' - не помогло' : ''}
          </div>
        )}
        {Object.keys(open.ticket.fields).length > 0 && (
          <div>
            <b>Детали:</b>{' '}
            {Object.entries(open.ticket.fields)
              .map(([k, v]) => `${open.ticket.fieldLabels[k] ?? k}: ${v}`)
              .join('; ')}
          </div>
        )}
        {closed && (
          <div>
            <b>Закрыто:</b> <ClosedBy t={open.ticket} />
            {open.ticket.rating ? ` · оценка ${open.ticket.rating}/5` : ''}
          </div>
        )}
      </div>

      {withAssistant && (
        <div className="notice">
          Обращение передано помощнику. Он снова ведёт диалог и не будет передавать его специалисту.
        </div>
      )}
      {showCard && <TicketCardPanel ticket={open.ticket} />}
      <div className="chat">
        {open.messages.map((m) => (
          <MessageBubble key={m.id} message={m} perspective="operator" />
        ))}
      </div>

      <details className="op-notes">
        <summary>Заметки специалиста {notes.trim() ? '•' : ''}</summary>
        <textarea
          rows={3}
          value={notes}
          placeholder="Пользователю не видны: что проверили, кому передали, что обещали…"
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => {
            if (notes !== open.notes) void api.operatorNotes(open.ticket.id, notes).catch(() => {});
          }}
        />
      </details>

      {!closed && (
        <>
          <div className="op-templates">
            {TEMPLATES.map((t) => (
              <button
                key={t.label}
                className="pill-btn"
                onClick={() => setText((v) => (v ? v + ' ' : '') + t.text)}
              >
                {t.label}
              </button>
            ))}
          </div>
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
                    playSend();
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
                  playSend();
                  setText('');
                })
              }
              aria-label="Отправить"
            >
              <Icon name="send" size={18} />
            </button>
          </div>
        </>
      )}
    </>
  );
}

function QueueChip({ t }: { t: QueueItem }) {
  if (t.group === 1) return <span className="chip danger">ждёт ответа</span>;
  if (t.group === 0 && t.unanswered) return <span className="chip warn">новое сообщение</span>;
  if (t.group === 2) return <span className="chip">{t.assignedTo ?? 'в работе'}</span>;
  if (t.group >= 3) return <ClosedBy t={t} chip />;
  return null;
}

/** AI: Кто закрыл: помощник / help.tpu.ru / специалист (имя) / пользователь. */
function ClosedBy({ t, chip }: { t: TicketCard; chip?: boolean }) {
  const label =
    t.closedBy === 'operator'
      ? `специалист${t.closedByName ? `: ${t.closedByName}` : ''}`
      : t.closedBy === 'user'
        ? 'пользователь отозвал'
        : t.escalatedTo === 'helpdesk'
          ? 'через help.tpu.ru'
          : 'помощник';
  const cls = t.closedBy === 'user' ? '' : 'ok';
  return chip ? <span className={`chip ${cls}`}>{label}</span> : <span>{label}</span>;
}

function StatsStrip({ stats }: { stats: OperatorStats }) {
  const p = (s: OperatorStatsPeriod) => ({
    ...s,
    avg: s.ratingCount ? (s.ratingSum / s.ratingCount).toFixed(1) : '-',
    aiShare: s.created ? Math.round((s.resolvedByAssistant / s.created) * 100) : 0,
  });
  const t = p(stats.today);
  const w = p(stats.week);
  return (
    <div className="op-stats">
      <div>
        <b>{stats.openQueue}</b>
        <small>в очереди сейчас</small>
      </div>
      <div>
        <b>{t.created}</b>
        <small>обращений сегодня · {w.created} за 7 дней</small>
      </div>
      <div>
        <b>{t.resolvedByAssistant}</b>
        <small>
          решил помощник · {t.aiShare} % · {w.resolvedByAssistant} за 7 дней
        </small>
      </div>
      <div>
        <b>{t.closedByOperator}</b>
        <small>закрыли специалисты · {w.closedByOperator} за 7 дней</small>
      </div>
      <div>
        <b>{t.sentToHelpdesk}</b>
        <small>в help.tpu.ru · {w.sentToHelpdesk} за 7 дней</small>
      </div>
      <div>
        <b>{t.avg}</b>
        <small>
          средняя оценка · {w.avg} за 7 дней ({w.ratingCount})
        </small>
      </div>
      {stats.budget.dailyTokenBudget > 0 && (
        <div className={stats.budget.stage !== 'ok' ? 'warn' : ''}>
          <b>{Math.round((stats.budget.usedShare ?? 0) * 100)} %</b>
          <small>
            {stats.budget.stage === 'all_off'
              ? 'бюджет модели исчерпан: все ответы по базе знаний'
              : stats.budget.stage === 'guests_off'
                ? 'бюджет модели: гости без модели'
                : `бюджет модели за сутки · ${Math.round(stats.budget.tokensToday / 1000)}k токенов`}
          </small>
        </div>
      )}
    </div>
  );
}
