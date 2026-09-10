import pino from 'pino';
import { TOPICS } from '@helpdesk/shared';
import { loadConfig } from '@helpdesk/api/dist/config.js';
import { connectDb, ensureSchema } from '@helpdesk/api/dist/db/client.js';
import { createEventBus } from '@helpdesk/api/dist/modules/events/index.js';
import { startBot } from './bot.js';
import { AnalyticsConsumer } from './consumers/analytics.js';
import { NotifierConsumer } from './consumers/notifier.js';

/**
 * Worker process = Kafka consumers + Telegram bot. Scales independently of the API:
 * run N replicas, Kafka consumer groups spread partitions across them.
 *
 *  support.notification.v1 -> notifier  (sends Telegram messages: "ticket handed to a specialist")
 *  support.ticket.v1       -> analytics (daily_stats per tenant/category)
 *  support.llm-usage.v1    -> analytics (token spend)
 */
const config = loadConfig();
const log = pino({
  level: config.LOG_LEVEL,
  ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});

const dbHandle = await connectDb({ url: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR + '-worker' });
await ensureSchema(dbHandle.db);

const events = await createEventBus({
  kind: config.EVENT_BUS,
  brokers: config.KAFKA_BROKERS,
  clientId: 'helpdesk-worker',
  log: { info: (m) => log.info(m), error: (o, m) => log.error(o as object, m) },
});
if (config.EVENT_BUS === 'memory') {
  log.warn('EVENT_BUS=memory: the worker cannot receive events from the API process. Use kafka for real deployments.');
}

const bot = config.TELEGRAM_BOT_TOKEN ? await startBot(config.TELEGRAM_BOT_TOKEN, config.WEB_APP_URL, log) : null;

const notifier = new NotifierConsumer(bot, log);
const analytics = new AnalyticsConsumer(dbHandle.db, log);

await events.subscribe(TOPICS.notifications, 'helpdesk-notifier', (e) => notifier.handle(e));
await events.subscribe(TOPICS.ticketEvents, 'helpdesk-analytics', (e) => analytics.onTicketEvent(e));
await events.subscribe(TOPICS.llmUsage, 'helpdesk-analytics', (e) => analytics.onLlmUsage(e));
log.info('worker: consumers running');

const shutdown = async () => {
  log.info('worker: shutting down');
  await events.close();
  await bot?.stop();
  await dbHandle.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
