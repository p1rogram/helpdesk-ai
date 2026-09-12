import { z } from 'zod';

export const TicketStateSchema = z.enum([
  'intake', // waiting for the first / next description
  'clarifying', // engine asked a clarifying question
  'choosing_category', // low confidence - user picks category from buttons
  'solving', // solution has been shown, waiting for "helped / not helped"
  'offer_escalation', // assistant cannot help further and asks whether to create a request
  'closed', // resolved
  'escalated', // handed over to a specialist
]);
export type TicketState = z.infer<typeof TicketStateSchema>;

export const ToneSchema = z.enum(['neutral', 'frustrated', 'abusive']);
export type Tone = z.infer<typeof ToneSchema>;

export const PrioritySchema = z.enum(['low', 'normal', 'high']);
export type Priority = z.infer<typeof PrioritySchema>;

/**
 * AI: Структурированный вывод вызова модели «analyze». Всё, что нужно движку, чтобы выбрать
 * следующий шаг. Потоком управления владеет движок, а не модель.
 */
export const AnalysisSchema = z.object({
  /** AI: Один из id категорий каталога или "unknown", если ничего не подходит. */
  categoryId: z.string(),
  /** AI: 0..1 - насколько модель уверена в категории. */
  confidence: z.number().min(0).max(1),
  /** AI: Формулировка проблемы одним предложением на языке пользователя, для карточки тикета. */
  summary: z.string(),
  /** AI: Извлечённые значения полей уточнения категории (id -> значение). */
  fields: z.record(z.string(), z.string()),
  tone: ToneSchema,
  /**
   * AI: Сообщение не является обращением в поддержку (приветствие, болтовня, спасибо, шутки, игры с
   * промптом).
   */
  offTopic: z.boolean(),
  /**
   * AI: При offTopic: короткий, тёплый, человеческий ответ на языке пользователя (1-2 предложения),
   * мягко возвращающий к проблеме.
   */
  smalltalkReply: z.string().optional(),
  /** AI: Пользователь прямо говорит, что проблема решена. */
  reportsResolved: z.boolean(),
  /**
   * AI: Пользователь просит завершить / закрыть обращение («закрой заявку», «всё, спасибо,
   * закрывай»).
   */
  asksToClose: z.boolean().optional(),
  /** AI: Пользователь прямо просит человека. */
  asksForHuman: z.boolean(),
  /**
   * AI: Несколько независимых проблем в одном сообщении («не работает VPN и в общаге нет воды») -
   * каждая коротко, 2-3 штуки. Пусто или одна, когда проблема одна.
   */
  problems: z.array(z.string()).optional(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const QuickReplySchema = z.object({
  label: z.string(),
  /** AI: Значение, которое отправляется обратно как сообщение пользователя. */
  value: z.string(),
});
export type QuickReply = z.infer<typeof QuickReplySchema>;

export const TicketCardSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  state: TicketStateSchema,
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  priority: PrioritySchema,
  confidence: z.number().nullable(),
  summary: z.string().nullable(),
  fields: z.record(z.string(), z.string()),
  /** AI: Id поля -> человеческая подпись из категории (на клиенте при отсутствии - сам id). */
  fieldLabels: z.record(z.string(), z.string()),
  tone: ToneSchema,
  articleId: z.string().nullable(),
  articleTitle: z.string().nullable(),
  resolved: z.boolean(),
  escalated: z.boolean(),
  rating: z.number().int().min(1).max(5).nullable(),
  /** AI: Вопросы, заданные одним сообщением и ещё ждущие ответа (ids полей). */
  pendingFields: z.array(z.string()),
  /** AI: Проблемы из того же сообщения, до которых ещё не дошли (по одной на обращение). */
  pendingProblems: z.array(z.string()),
  /** AI: Кто завершил тикет: помощник (решено), специалист или пользователь (отозвано). */
  closedBy: z.enum(['assistant', 'operator', 'user']).nullable(),
  /** AI: Кто сейчас владеет диалогом. Пока 'operator', помощник молчит. */
  handledBy: z.enum(['ai', 'operator']),
  /** AI: Оператор вернул этот тикет помощнику и запретил дальнейшую передачу. */
  escalationBlocked: z.boolean(),
  /** AI: Номер заявки во внешнем helpdesk (help.tpu.ru), когда она создана. */
  externalId: z.string().nullable(),
  externalUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TicketCard = z.infer<typeof TicketCardSchema>;
