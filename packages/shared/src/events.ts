import { z } from 'zod';
import { TicketCardSchema, ToneSchema } from './dialog.js';
import { PlatformSchema } from './api.js';

/**
 * AI: Доменные события. Публикует API, потребляют worker-ы через Kafka.
 * Именование топиков: <домен>.<сущность>.<версия>. Ключ партиции: ticketId (порядок внутри тикета).
 */
export const TOPICS = {
  ticketEvents: 'support.ticket.v1',
  llmUsage: 'support.llm-usage.v1',
  notifications: 'support.notification.v1',
} as const;

const base = {
  eventId: z.string(),
  occurredAt: z.string(),
  ticketId: z.string(),
  userId: z.string(),
};

export const TicketEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('ticket.created'), ticket: TicketCardSchema }),
  /**
   * AI: Всё, что меняет то, что должен видеть оператор (новое сообщение пользователя, возврат,
   * ответ).
   */
  z.object({ ...base, type: z.literal('ticket.updated'), tenantId: z.string() }),
  z.object({
    ...base,
    type: z.literal('ticket.classified'),
    categoryId: z.string(),
    confidence: z.number(),
    tone: ToneSchema,
  }),
  z.object({ ...base, type: z.literal('ticket.solution_shown'), articleId: z.string() }),
  z.object({ ...base, type: z.literal('ticket.resolved'), ticket: TicketCardSchema }),
  /** AI: Завершено без решения: пользователь отозвал обращение (не считается решённым). */
  z.object({
    ...base,
    type: z.literal('ticket.closed'),
    by: z.enum(['user', 'operator']),
    ticket: TicketCardSchema,
  }),
  z.object({
    ...base,
    type: z.literal('ticket.escalated'),
    reason: z.string(),
    ticket: TicketCardSchema,
  }),
  z.object({
    ...base,
    type: z.literal('ticket.rated'),
    rating: z.number(),
    comment: z.string().optional(),
  }),
]);
export type TicketEvent = z.infer<typeof TicketEventSchema>;

export const LlmUsageEventSchema = z.object({
  eventId: z.string(),
  occurredAt: z.string(),
  ticketId: z.string(),
  operation: z.enum(['analyze', 'solve', 'answer']),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  latencyMs: z.number(),
});
export type LlmUsageEvent = z.infer<typeof LlmUsageEventSchema>;

export const NotificationEventSchema = z.object({
  eventId: z.string(),
  occurredAt: z.string(),
  ticketId: z.string(),
  platform: PlatformSchema,
  platformUserId: z.string(),
  text: z.string(),
});
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;
