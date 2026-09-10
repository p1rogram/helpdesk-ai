import { TOPICS, type TicketEvent } from '@helpdesk/shared';
import type { EventBus } from '../events/index.js';

/**
 * Live channel for operator consoles. Every open console holds one SSE connection; whenever a
 * ticket of its tenant changes (new escalation, user message, operator reply, close, hand-back)
 * the hub tells it to refresh.
 *
 * The trigger comes from the event bus, so with Kafka every API replica notifies the operators
 * connected to it - no sticky sessions needed.
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

  /** Ask every console of this tenant to reload the queue (and the open ticket, if it matches). */
  notify(tenantId: string, ticketId?: string): void {
    const payload = JSON.stringify({ type: 'queue', ticketId: ticketId ?? null, at: new Date().toISOString() });
    for (const c of this.clients) {
      if (c.tenantId !== tenantId) continue;
      try {
        c.send(payload);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  /** Subscribe to the ticket topic once at boot. */
  async attach(bus: EventBus, resolveTenant: (ticketId: string) => Promise<string | null>): Promise<void> {
    await bus.subscribe(TOPICS.ticketEvents, 'operator-hub', async (e: TicketEvent) => {
      if (this.clients.size === 0) return;
      const tenantId =
        'tenantId' in e ? e.tenantId : 'ticket' in e ? e.ticket.tenantId : await resolveTenant(e.ticketId);
      if (tenantId) this.notify(tenantId, e.ticketId);
    });
  }
}
