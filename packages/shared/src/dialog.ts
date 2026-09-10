import { z } from 'zod';

export const TicketStateSchema = z.enum([
  'intake', // waiting for the first / next description
  'clarifying', // engine asked a clarifying question
  'choosing_category', // low confidence - user picks category from buttons
  'solving', // solution has been shown, waiting for "helped / not helped"
  'closed', // resolved
  'escalated', // handed over to a specialist
]);
export type TicketState = z.infer<typeof TicketStateSchema>;

export const ToneSchema = z.enum(['neutral', 'frustrated', 'abusive']);
export type Tone = z.infer<typeof ToneSchema>;

export const PrioritySchema = z.enum(['low', 'normal', 'high']);
export type Priority = z.infer<typeof PrioritySchema>;

/**
 * Structured output of the "analyze" LLM call. Everything the engine needs to decide
 * the next step. The engine - not the model - owns the control flow.
 */
export const AnalysisSchema = z.object({
  /** One of catalog category ids, or "unknown" when nothing fits. */
  categoryId: z.string(),
  /** 0..1 - how sure the model is about the category. */
  confidence: z.number().min(0).max(1),
  /** One-sentence problem statement in the language of the user, for the ticket card. */
  summary: z.string(),
  /** Extracted values for the clarifying fields of the category (id -> value). */
  fields: z.record(z.string(), z.string()),
  tone: ToneSchema,
  /** The message is not a support request (greeting, chit-chat, thanks, jokes, prompt games). */
  offTopic: z.boolean(),
  /** When offTopic: a short, warm, human reply in the language of the user (1-2 sentences) that gently steers back to the problem. */
  smalltalkReply: z.string().optional(),
  /** User explicitly says the problem is solved. */
  reportsResolved: z.boolean(),
  /** User explicitly asks for a human. */
  asksForHuman: z.boolean(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const QuickReplySchema = z.object({
  label: z.string(),
  /** Value sent back as the message of the user. */
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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TicketCard = z.infer<typeof TicketCardSchema>;
