import pino from 'pino';
import { TOPICS } from '@helpdesk/shared';
import { loadConfig } from '@helpdesk/api/dist/config.js';
import { connectDb, ensureSchema } from '@helpdesk/api/dist/db/client.js';
import { createEventBus } from '@helpdesk/api/dist/modules/events/index.js';
import { startBot } from './bot.js';
import { AnalyticsConsumer } from './consumers/analytics.js';
import { NotifierConsumer } from './consumers/notifier.js';

/**
 * AI: Процесс worker = потребители Kafka + Telegram-бот. Масштабируется независимо от API:
 * запускайте N реплик, consumer groups Kafka распределят партиции между ними.
 *
 *  support.notification.v1 -> notifier  (шлёт сообщения в Telegram: «обращение передано специалисту»)
 *  support.ticket.v1       -> analytics (daily_stats по тенанту/категории)
 *  support.llm-usage.v1    -> analytics (расход токенов)
 */
const config = loadConfig();
const log = pino({
  level: config.LOG_LEVEL,
  ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});

const dbHandle = await connectDb({
  url: config.DATABASE_URL,
  pgliteDir: config.PGLITE_DIR + '-worker',
});
await ensureSchema(dbHandle.db);

const events = await createEventBus({
  kind: config.EVENT_BUS,
  brokers: config.KAFKA_BROKERS,
  clientId: 'helpdesk-worker',
  log: { info: (m) => log.info(m), error: (o, m) => log.error(o as object, m) },
});
if (config.EVENT_BUS === 'memory') {
  log.warn(
    'EVENT_BUS=memory: the worker cannot receive events from the API process. Use kafka for real deployments.',
  );
}

const bot = config.TELEGRAM_BOT_TOKEN
  ? await startBot(config.TELEGRAM_BOT_TOKEN, config.WEB_APP_URL, log, config.TELEGRAM_API_ROOT)
  : null;

const notifier = new NotifierConsumer(bot, log);
const analytics = new AnalyticsConsumer(dbHandle.db, log);

await events.subscribe(TOPICS.notifications, 'helpdesk-notifier', (e) => notifier.handle(e));
// AI: По одной consumer group на топик - общий group id для нескольких топиков заставляет Kafka
// перебалансироваться по кругу.
await events.subscribe(TOPICS.ticketEvents, 'helpdesk-analytics-tickets', (e) =>
  analytics.onTicketEvent(e),
);
await events.subscribe(TOPICS.llmUsage, 'helpdesk-analytics-llm', (e) => analytics.onLlmUsage(e));
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
