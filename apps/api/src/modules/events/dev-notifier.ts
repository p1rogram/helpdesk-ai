import { TOPICS } from '@helpdesk/shared';
import type { EventBus } from './bus.js';

/**
 * Dev-only: with EVENT_BUS=memory there is no worker process listening, so the API delivers
 * Telegram notifications itself. In production Kafka + the worker do this (see apps/worker).
 */
export async function attachDevTelegramNotifier(
  bus: EventBus,
  botToken: string,
  log: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void },
): Promise<void> {
  await bus.subscribe(TOPICS.notifications, 'dev-notifier', async (e) => {
    if (e.platform !== 'telegram') return;
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(e.platformUserId), text: e.text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) log.warn({ status: res.status, ticketId: e.ticketId }, 'dev notifier: telegram sendMessage failed');
    else log.info({ ticketId: e.ticketId }, 'dev notifier: telegram notification sent');
  });
  log.info({}, 'dev notifier: in-process Telegram notifications enabled (EVENT_BUS=memory)');
}
