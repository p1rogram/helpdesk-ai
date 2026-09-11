import { randomUUID } from 'node:crypto';
import type { LlmUsageEvent, NotificationEvent, TicketEvent } from '@helpdesk/shared';
import { TOPICS } from '@helpdesk/shared';

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

export interface TopicPayloads {
  [TOPICS.ticketEvents]: TicketEvent;
  [TOPICS.llmUsage]: LlmUsageEvent;
  [TOPICS.notifications]: NotificationEvent;
}

/**
 * AI: Шина событий, не зависящая от транспорта. Бизнес-код зависит только от этого интерфейса.
 * Реализации: MemoryEventBus (dev/тесты), KafkaEventBus (prod).
 */
export interface EventBus {
  publish<T extends TopicName>(topic: T, key: string, event: TopicPayloads[T]): Promise<void>;
  subscribe<T extends TopicName>(
    topic: T,
    groupId: string,
    handler: (event: TopicPayloads[T]) => Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
}

export const eventBase = (ticketId: string, userId: string) => ({
  eventId: randomUUID(),
  occurredAt: new Date().toISOString(),
  ticketId,
  userId,
});
