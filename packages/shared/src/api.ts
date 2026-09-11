import { z } from 'zod';
import { QuickReplySchema, TicketCardSchema } from './dialog.js';

export const PlatformSchema = z.enum(['telegram', 'vk', 'max', 'web', 'corp']);

/** AI: Какую часть базы знаний может видеть сессия. */
export const ScopeSchema = z.enum(['guest', 'full']);
export type Scope = z.infer<typeof ScopeSchema>;
export type Platform = z.infer<typeof PlatformSchema>;

export const TelegramAuthRequestSchema = z.object({
  initData: z.string().min(1).max(8192),
});

export const AuthResponseSchema = z.object({
  token: z.string(),
  user: z.object({
    id: z.string(),
    platform: PlatformSchema,
    displayName: z.string(),
    scope: ScopeSchema,
  }),
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const SendMessageRequestSchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

export const RateRequestSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(500).optional(),
});

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  createdAt: z.string(),
  quickReplies: z.array(QuickReplySchema).optional(),
  /** AI: Ставится, когда сообщение написал живой оператор (имя показывается в чате). */
  author: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** AI: События Server-Sent Events, выдаваемые при ответе на одно сообщение пользователя. */
export const ChatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('meta'), ticket: TicketCardSchema }),
  /** AI: Progress hint shown while the model works ("Определяю категорию…"). */
  z.object({ type: z.literal('status'), text: z.string() }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  /** AI: Сообщение принято, но помощник намеренно молчит (чатом владеет оператор). */
  z.object({ type: z.literal('ack'), ticket: TicketCardSchema }),
  z.object({
    type: z.literal('done'),
    message: ChatMessageSchema,
    ticket: TicketCardSchema,
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;

export const KbSearchResultSchema = z.object({
  id: z.string(),
  categoryId: z.string(),
  title: z.string(),
  steps: z.array(z.string()),
  score: z.number(),
});
export type KbSearchResult = z.infer<typeof KbSearchResultSchema>;

/** AI: Фрагмент документации, найденный индексом RAG (скачанные help.tpu.ru / tpu.ru). */
export const DocPassageSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  section: z.string(),
  snippet: z.string(),
});
export type DocPassage = z.infer<typeof DocPassageSchema>;
