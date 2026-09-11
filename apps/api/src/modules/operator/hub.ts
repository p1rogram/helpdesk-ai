import { TOPICS, type TicketEvent } from '@helpdesk/shared';
import type { EventBus } from '../events/index.js';

/**
 * AI: Живой канал для консолей операторов. Каждая открытая консоль держит одно SSE-соединение; при
 * любом изменении тикета её тенанта (новая передача, сообщение пользователя, ответ оператора,
 * закрытие, возврат) хаб просит её обновиться.
 *
 * Триггер приходит из шины событий, поэтому с Kafka каждая реплика API оповещает подключённых к ней
 * операторов - sticky-сессии не нужны.
 */
export interface OperatorClient {
  tenantId: string;
  send(payload: string): void;
}

export class OperatorHub {
  private readonly clients = new Set<OperatorClient>();

  add(client: OperatorClient): () => void {
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  get size(): number {
    return this.clients.size;
  }

  /**
   * AI: Попросить все консоли этого тенанта перезагрузить очередь (и открытый тикет, если он
   * совпадает).
   */
  notify(tenantId: string, ticketId?: string): void {
    const payload = JSON.stringify({
      type: 'queue',
      ticketId: ticketId ?? null,
      at: new Date().toISOString(),
    });
    for (const c of this.clients) {
      if (c.tenantId !== tenantId) continue;
      try {
        c.send(payload);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  /** AI: Подписаться на топик тикетов один раз при старте. */
  async attach(
    bus: EventBus,
    resolveTenant: (ticketId: string) => Promise<string | null>,
  ): Promise<void> {
    await bus.subscribe(TOPICS.ticketEvents, 'operator-hub', async (e: TicketEvent) => {
      if (this.clients.size === 0) return;
      const tenantId =
        'tenantId' in e
          ? e.tenantId
          : 'ticket' in e
            ? e.ticket.tenantId
            : await resolveTenant(e.ticketId);
      if (tenantId) this.notify(tenantId, e.ticketId);
    });
  }
}
