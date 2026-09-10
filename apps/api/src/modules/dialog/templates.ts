import type { Category, KbArticle, QuickReply, TicketCard } from '@helpdesk/shared';

/**
 * Deterministic assistant texts. No LLM cost, no variance, always polite.
 * Quick-reply values prefixed with "__" are engine commands, never sent to the model.
 */
export const CMD = {
  helped: '__helped',
  notHelped: '__not_helped',
  human: '__human',
  category: '__cat:',
  newTicket: '__new',
} as const;

export const QR_AFTER_SOLUTION: QuickReply[] = [
  { label: 'Помогло ✅', value: CMD.helped },
  { label: 'Не помогло', value: CMD.notHelped },
  { label: 'Нужен специалист', value: CMD.human },
];

export const QR_CLOSED: QuickReply[] = [{ label: 'Новое обращение', value: CMD.newTicket }];

export const T = {
  greeting: (sphere: string) =>
    `Привет! Я помощник поддержки — ${sphere.replace(/^Техническая поддержка /, '')}. Расскажите своими словами, что случилось: что не работает и где — постараюсь помочь.`,

  offTopic: () => `Я здесь, чтобы помочь с технической проблемой. Расскажите, что не работает — разберёмся.`,

  smalltalk: (text: string, solving = false): string => {
    const t = text.toLowerCase();
    if (/спасибо|спс|благодар/.test(t))
      return solving ? `Пожалуйста! Если шаги помогли — нажмите «Помогло», чтобы я закрыл обращение.` : `Пожалуйста! Если что-то ещё сломается — пишите.`;
    if (solving && /ты тут|ты здесь|есть кто|ау|эй/.test(t)) return `Да, здесь. Получилось выполнить шаги? Нажмите «Помогло» или «Не помогло».`;
    if (/пока|до свидания/.test(t)) return `Хорошего дня! Обращайтесь, если понадобится помощь.`;
    if (/кто ты|ты кто|что ты умеешь/.test(t))
      return `Я помощник техподдержки: помогаю разобраться с учётной записью, Moodle, VPN, Wi-Fi, почтой, принтерами и бытовыми вопросами. Опишите проблему — подскажу, что делать.`;
    if (/ты тут|ты здесь|есть кто|ау|эй/.test(t)) return `Да, на месте! Расскажите, что случилось.`;
    if (/как дела/.test(t)) return `Всё в порядке, спасибо! Чем помочь?`;
    if (/^(ок|окей|ok|понял|пон|ясно|хорошо|ладно)/.test(t)) return `Отлично. Если появится вопрос — я здесь.`;
    return `Здравствуйте! Расскажите, что не работает — постараюсь помочь.`;
  },

  chooseCategory: () =>
    `Уточните, к чему относится обращение — выберите вариант ниже.`,

  categoryButtons: (cats: Category[]): QuickReply[] =>
    cats.map((c) => ({ label: c.name, value: `${CMD.category}${c.id}` })),

  clarify: (question: string) => question,

  clarifyButtons: (options?: string[]): QuickReply[] | undefined =>
    options?.map((o) => ({ label: o, value: o })),

  /** LLM-less fallback: article steps verbatim. */
  solutionFallback: (article: KbArticle) =>
    [`Похоже, это «${article.title}». Попробуйте по шагам:`, ...article.steps.map((s, i) => `${i + 1}. ${s}`)].join(
      '\n',
    ),

  afterSolution: () => `Напишите, помогло ли.`,

  noted: () => `Учёл. Попробуйте шаги выше и нажмите «Помогло» или «Не помогло».`,

  nextArticle: (article: KbArticle) => `Понял. Есть ещё один вариант — «${article.title}»:`,

  resolved: (card: TicketCard) =>
    [
      `Отлично, рад, что помогло!`,
      `Коротко, что было: ${card.summary ?? '—'} (${card.categoryName ?? '—'}) — решено ✅`,
      ``,
      `Если не сложно, оцените ответ — это помогает делать помощника лучше.`,
    ].join('\n'),

  escalated: (card: TicketCard, reason: EscalationReason) =>
    [
      escalationLead[reason],
      `Я передал обращение специалисту — вот что он получит:`,
      `• Проблема: ${card.summary ?? 'уточняется'}`,
      `• Категория: ${card.categoryName ?? 'не определена'}`,
      `• Приоритет: ${priorityLabel[card.priority]}`,
      Object.keys(card.fields).length
        ? `• Детали: ${Object.entries(card.fields)
            .map(([k, v]) => `${k} — ${v}`)
            .join('; ')}`
        : '',
      `• Номер: ${card.id.slice(0, 8).toUpperCase()}`,
      ``,
      `Делать ничего не нужно: специалист напишет сюда, уведомление придёт автоматически.`,
    ]
      .filter(Boolean)
      .join('\n'),

  closedHint: () => `Это обращение уже закрыто. Нажмите «Новое обращение», чтобы описать другую проблему.`,

  llmDown: () =>
    `Сейчас я работаю в упрощённом режиме, но всё равно постараюсь помочь.`,
};

export type EscalationReason = 'user_request' | 'no_solution' | 'solution_failed' | 'article_requires_specialist' | 'low_confidence';

const escalationLead: Record<EscalationReason, string> = {
  user_request: `Хорошо, подключаю специалиста.`,
  no_solution: `Для этой ситуации у меня нет проверенного решения — гадать не буду. Возможно, ответ есть на официальном сайте https://tpu.ru или на портале поддержки https://help.tpu.ru.`,
  solution_failed: `Стандартные шаги не помогли — дальше нужна диагностика специалиста.`,
  article_requires_specialist: `Чтобы ситуацию взяли на контроль, я также передал обращение специалисту.`,
  low_confidence: `Я не смог уверенно понять, в чём проблема, поэтому передаю её человеку. Пока ждёте, загляните на https://tpu.ru — там может быть нужная информация.`,
};

const priorityLabel = { low: 'низкий', normal: 'обычный', high: 'высокий' } as const;
