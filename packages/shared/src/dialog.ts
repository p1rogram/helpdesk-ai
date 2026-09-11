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
 * AI: Structured output of the "analyze" LLM call. Everything the engine needs to decide
 * the next step. The engine - not the model - owns the control flow.
 */
export const AnalysisSchema = z.object({
  /** AI: One of catalog category ids, or "unknown" when nothing fits. */
  categoryId: z.string(),
  /** AI: 0..1 - how sure the model is about the category. */
  confidence: z.number().min(0).max(1),
  /** AI: One-sentence problem statement in the language of the user, for the ticket card. */
  summary: z.string(),
  /** AI: Extracted values for the clarifying fields of the category (id -> value). */
  fields: z.record(z.string(), z.string()),
  tone: ToneSchema,
  /** AI: The message is not a support request (greeting, chit-chat, thanks, jokes, prompt games). */
  offTopic: z.boolean(),
  /** AI: When offTopic: a short, warm, human reply in the language of the user (1-2 sentences) that gently steers back to the problem. */
  smalltalkReply: z.string().optional(),
  /** AI: User explicitly says the problem is solved. */
  reportsResolved: z.boolean(),
  /** AI: User asks to finish / close the request ("закрой заявку", "всё, спасибо, закрывай"). */
  asksToClose: z.boolean().optional(),
  /** AI: User explicitly asks for a human. */
  asksForHuman: z.boolean(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const QuickReplySchema = z.object({
  label: z.string(),
  /** AI: Value sent back as the message of the user. */
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
  tone: ToneSchema,
  articleId: z.string().nullable(),
  articleTitle: z.string().nullable(),
  resolved: z.boolean(),
  escalated: z.boolean(),
  rating: z.number().int().min(1).max(5).nullable(),
  /** AI: Who owns the dialogue right now. While 'operator', the assistant stays silent. */
  handledBy: z.enum(['ai', 'operator']),
  /** AI: The operator handed this ticket back to the assistant and declined further escalation. */
  escalationBlocked: z.boolean(),
  /** AI: Request number in the external helpdesk (help.tpu.ru), once created. */
  externalId: z.string().nullable(),
  externalUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TicketCard = z.infer<typeof TicketCardSchema>;
