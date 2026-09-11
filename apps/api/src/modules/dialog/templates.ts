import type { Category, KbArticle, QuickReply, TicketCard } from '@helpdesk/shared';

/**
 * AI: Deterministic assistant texts. No LLM cost, no variance, always polite.
 * Quick-reply values prefixed with "__" are engine commands, never sent to the model.
 */
export const CMD = {
  helped: '__helped',
  notHelped: '__not_helped',
  human: '__human',
  category: '__cat:',
  newTicket: '__new',
  escalate: '__escalate',
  dismiss: '__dismiss',
  /** AI: The user withdraws the request (any state, including "with a specialist"). */
  close: '__close',
  keep: '__keep',
} as const;

export const QR_AFTER_SOLUTION: QuickReply[] = [
  { label: 'Помогло', value: CMD.helped },
  { label: 'Не помогло', value: CMD.notHelped },
  { label: 'Нужен специалист', value: CMD.human },
];

/** AI: Nothing at the bottom after a closed ticket - a new chat is started from the header button. */
export const QR_CLOSED: QuickReply[] = [];

/** AI: Escalation is blocked for this ticket: the only way out is a fresh request. */
export const QR_NEW_ONLY: QuickReply[] = [];

export const QR_HELPED_ONLY: QuickReply[] = [
  { label: 'Помогло', value: CMD.helped },
  { label: 'Не помогло', value: CMD.notHelped },
];

export const QR_OFFER_ESCALATION: QuickReply[] = [
  { label: 'Создать заявку специалисту', value: CMD.escalate },
  { label: 'Не нужно', value: CMD.dismiss },
];

export const QR_CLOSED_OR_NEW: QuickReply[] = [{ label: 'Нужен специалист', value: CMD.human }];

/**
 * AI: While a specialist owns the ticket the user can still withdraw it - through the persistent
 * bar under the chat (survives the user's own messages), so no button in the message itself.
 */
export const QR_ESCALATED: QuickReply[] = [];

/** AI: Asked when a message to the specialist sounds like "this is no longer relevant". */
export const QR_CONFIRM_CLOSE: QuickReply[] = [
  { label: 'Закрыть обращение', value: CMD.close },
  { label: 'Оставить', value: CMD.keep },
];

export const T = {
  greeting: (sphere: string) =>
    `Привет! Я помощник поддержки — ${sphere.replace(/^Техническая поддержка /, '')}. Расскажите своими словами, что случилось: что не работает и где — постараюсь помочь.`,

  offTopic: () =>
    `Я здесь, чтобы помочь с технической проблемой. Расскажите, что не работает — разберёмся.`,

  smalltalk: (text: string, solving = false): string => {
    const t = text.toLowerCase();
    if (/спасибо|спс|благодар/.test(t))
      return solving
        ? `Пожалуйста! Если шаги помогли — нажмите «Помогло», чтобы я закрыл обращение.`
        : `Пожалуйста! Если что-то ещё сломается — пишите.`;
    if (solving && /ты тут|ты здесь|есть кто|ау|эй/.test(t))
      return `Да, здесь. Получилось выполнить шаги? Нажмите «Помогло» или «Не помогло».`;
    if (/пока|до свидания/.test(t)) return `Хорошего дня! Обращайтесь, если понадобится помощь.`;
    if (/кто ты|ты кто|что ты умеешь/.test(t))
      return `Я помощник поддержки ТПУ: учётная запись и сервисы, Moodle, VPN и Wi-Fi, почта, принтеры, общежития и бытовые проблемы, справки, стипендии, пропуска, библиотека, контакты. Опишите проблему — подскажу, что делать.`;
    if (/ты тут|ты здесь|есть кто|ау|эй/.test(t)) return `Да, на месте! Расскажите, что случилось.`;
    if (/как дела/.test(t)) return `Всё в порядке, спасибо! Чем помочь?`;
    if (/^(ок|окей|ok|понял|пон|ясно|хорошо|ладно)/.test(t))
      return `Отлично. Если появится вопрос — я здесь.`;
    return `Здравствуйте! Расскажите, что не работает — постараюсь помочь.`;
  },

  chooseCategory: () => `Уточните, к чему относится обращение — выберите вариант ниже.`,

  categoryButtons: (cats: Category[]): QuickReply[] =>
    cats.map((c) => ({ label: c.name, value: `${CMD.category}${c.id}` })),

  clarify: (question: string) => question,

  /** AI: One question before the hand-over, so the specialist gets the ticket ready to work on. */
  clarifyBeforeEscalation: (question: string) =>
    `Передам специалисту. Чтобы он сразу приступил, уточните: ${lowerFirst(question)}`,

  clarifyButtons: (options?: string[]): QuickReply[] | undefined =>
    options?.map((o) => ({ label: o, value: o })),

  /** AI: LLM-less fallback: article steps verbatim. */
  solutionFallback: (article: KbArticle) =>
    [
      `Похоже, это «${article.title}». Попробуйте по шагам:`,
      ...article.steps.map((s, i) => `${i + 1}. ${s}`),
    ].join('\n'),

  afterSolution: () => `Напишите, помогло ли.`,

  noted: () => `Учёл. Попробуйте шаги выше и нажмите «Помогло» или «Не помогло».`,

  nextArticle: (article: KbArticle) => `Понял. Есть ещё один вариант — «${article.title}»:`,

  resolved: (card: TicketCard, reason: 'helped' | 'user_request' = 'helped') =>
    [
      reason === 'user_request' ? `Готово, закрываю обращение.` : `Отлично, рад, что помогло!`,
      `Коротко, что было: ${card.summary ?? '—'} (${card.categoryName ?? '—'}) — решено.`,
      ``,
      `Если не сложно, оцените ответ — это помогает делать помощника лучше.`,
    ].join('\n'),

  /** AI: Confirmation for the "thanks for rating" line in the chat. */
  rated: (rating: number) =>
    rating >= 4
      ? `Спасибо за оценку ${rating}/5! Рад, что смог помочь.`
      : `Спасибо за оценку ${rating}/5. Учту — постараюсь отвечать точнее.`,

  /** AI: The user withdrew the request themselves. */
  closedByUser: (card: TicketCard) =>
    card.escalated
      ? `Обращение закрыто, специалист уведомлён. Если проблема вернётся — создайте новое обращение.`
      : `Обращение закрыто. Если проблема вернётся — создайте новое обращение.`,

  /** AI: A message to the specialist that sounds like "no longer relevant" - ask, never guess. */
  confirmClose: () =>
    `Похоже, вопрос больше не актуален. Закрыть обращение? Специалист получит уведомление.`,

  keptOpen: () => `Хорошо, обращение остаётся у специалиста. Он ответит в этот чат.`,

  /** AI: Asked before any request is created - the user decides. */
  offerEscalation: (reason: EscalationReason) =>
    [
      escalationLead[reason],
      `Могу создать заявку специалисту — он получит описание проблемы и всё, что мы уже выяснили, и ответит в этот чат. Создать?`,
    ].join('\n'),

  dismissed: (solving: boolean) =>
    solving
      ? `Хорошо, заявку не создаю. Если передумаете — нажмите «Нужен специалист».`
      : `Хорошо, заявку не создаю. Если захотите — нажмите «Нужен специалист» или опишите проблему подробнее.`,

  escalated: (card: TicketCard, reason: EscalationReason, missing: string[] = []) =>
    [
      reason === 'user_request' ? `Хорошо, подключаю специалиста.` : `Готово.`,
      card.externalId && card.externalUrl
        ? `Заявка №${card.externalId} создана: ${card.externalUrl}`
        : `Заявка №${card.externalId ?? card.id.slice(0, 8).toUpperCase()} создана.`,
      `Специалист получит:`,
      `• Проблема: ${card.summary ?? 'уточняется'}`,
      `• Категория: ${card.categoryName ?? 'не определена'}`,
      `• Приоритет: ${priorityLabel[card.priority]}`,
      Object.keys(card.fields).length
        ? `• Детали: ${Object.entries(card.fields)
            .map(([k, v]) => `${card.fieldLabels[k] ?? k} — ${v}`)
            .join('; ')}`
        : '',
      missing.length ? `• Не уточнено: ${missing.join(', ')} — специалист спросит сам.` : '',
      ``,
      `Делать ничего не нужно: специалист напишет сюда, уведомление придёт автоматически.`,
      `Если вопрос потеряет актуальность, обращение можно закрыть кнопкой ниже.`,
    ]
      .filter(Boolean)
      .join('\n'),

  /** AI: The operator returned the ticket and asked to solve it here. */
  handedBackToAi: () =>
    [
      `Специалист посмотрел обращение и передал его мне — по этому вопросу помощь специалиста не требуется.`,
      `Давайте разберёмся здесь: уточните, что именно не получается, и я подскажу по шагам.`,
    ].join('\n'),

  /** AI: Guests get answers, not requests: a specialist works only with identified users. */
  guestNoEscalation: (reason: EscalationReason) =>
    [
      reason === 'user_request' ? '' : escalationLead[reason],
      `Передать обращение специалисту в гостевом режиме нельзя — для этого нужен вход по учётной записи ТПУ (кнопка «Я студент или сотрудник ТПУ» на входе).`,
      `Если вопрос срочный: техподдержка ТПУ — https://help.tpu.ru, +7 (3822) 701-811, help@tpu.ru.`,
    ]
      .filter(Boolean)
      .join('\n'),

  escalationBlocked: () =>
    [
      `По этому обращению специалист уже принял решение: его нужно решать здесь, без передачи.`,
      `Опишите подробнее, что не получается — попробуем вместе. Если проблема другая, создайте новое обращение.`,
    ].join('\n'),

  /** AI: A stale button pressed while a specialist owns the dialogue. */
  withOperator: () =>
    `Обращение у специалиста — он ответит в этот чат. Если хотите что-то добавить, просто напишите.`,

  closedHint: () =>
    `Это обращение уже закрыто. Нажмите «Новый чат» вверху, чтобы описать другую проблему.`,

  llmDown: () => `Сейчас я работаю в упрощённом режиме, но всё равно постараюсь помочь.`,
};

export type EscalationReason =
  | 'user_request'
  | 'no_solution'
  | 'solution_failed'
  | 'article_requires_specialist'
  | 'low_confidence';

const escalationLead: Record<EscalationReason, string> = {
  user_request: `Хорошо, подключаю специалиста.`,
  no_solution: `Для этой ситуации у меня нет проверенного решения — гадать не буду. Возможно, ответ есть на официальном сайте https://tpu.ru или на портале поддержки https://help.tpu.ru.`,
  solution_failed: `Стандартные шаги не помогли — дальше нужна диагностика специалиста.`,
  article_requires_specialist: `Дальше это оформляется через специалиста.`,
  low_confidence: `Я не смог уверенно понять, в чём проблема, поэтому передаю её человеку. Пока ждёте, загляните на https://tpu.ru — там может быть нужная информация.`,
};

const priorityLabel = { low: 'низкий', normal: 'обычный', high: 'высокий' } as const;

function lowerFirst(s: string): string {
  return s.length ? s[0]!.toLowerCase() + s.slice(1) : s;
}
