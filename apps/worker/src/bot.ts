import { Bot, InlineKeyboard } from 'grammy';
import type { Logger } from 'pino';

/**
 * AI: Telegram-бот намеренно тонкий: открывает Mini App и доставляет уведомления. Весь диалог
 * происходит внутри Mini App (богатый UI, стрим, кнопки) - Bot API лишь транспорт для
 * push-сообщений.
 *
 * Сеть: используется глобальный fetch Node. Если api.telegram.org доступен только через прокси,
 * либо задайте TELEGRAM_API_ROOT на пробрасывающий worker (deploy/telegram-proxy.worker.js), либо
 * запускайте с NODE_USE_ENV_PROXY=1 и HTTPS_PROXY=... (Node >= 24).
 */
export async function startBot(
  token: string,
  webAppUrl: string | undefined,
  log: Logger,
  apiRoot?: string,
): Promise<Bot> {
  // AI: grammY по умолчанию использует свой шим node-fetch (полифилл AbortSignal, опция
  // `compress`), который нативный fetch отвергает. Используем глобальный fetch - он уважает
  // NODE_USE_ENV_PROXY - с нативным таймаутом.
  const nativeFetch: typeof fetch = (url, init) => {
    const {
      signal: _polyfilled,
      compress: _c,
      ...rest
    } = (init ?? {}) as RequestInit & { compress?: boolean };
    return globalThis.fetch(url, { ...rest, signal: AbortSignal.timeout(35_000) });
  };
  const bot = new Bot(token, {
    client: { timeoutSeconds: 30, fetch: nativeFetch, ...(apiRoot ? { apiRoot } : {}) },
  });

  bot.command('start', async (ctx) => {
    if (!webAppUrl) return ctx.reply('Помощник поддержки временно недоступен.');
    const kb = new InlineKeyboard().webApp('Открыть помощника поддержки', webAppUrl);
    await ctx.reply(
      'Здравствуйте! Я виртуальный помощник технической поддержки. Нажмите кнопку, чтобы описать проблему.',
      { reply_markup: kb },
    );
  });

  bot.on('message:text', async (ctx) => {
    if (!webAppUrl) return;
    const kb = new InlineKeyboard().webApp('Открыть помощника', webAppUrl);
    await ctx.reply(
      'Опишите проблему в приложении — так я смогу задать уточнения и показать пошаговое решение.',
      {
        reply_markup: kb,
      },
    );
  });

  bot.catch((err) => log.error({ err: err.error }, 'telegram bot error'));

  // AI: Проверяем токен заранее, чтобы ошибка конфигурации была видна при старте, а не на первом
  // сообщении.
  try {
    const me = await bot.api.getMe();
    log.info(`telegram bot: @${me.username} connected`);
  } catch (err) {
    // AI: Сырую ошибку не логируем никогда: grammY вставляет токен бота в URL запросов.
    const reason =
      err instanceof Error ? err.message.replace(/bot\d+:[\w-]+/g, 'bot***') : String(err);
    log.error(
      { reason },
      'telegram bot: cannot reach api.telegram.org (check token / proxy: NODE_USE_ENV_PROXY=1)',
    );
    return bot;
  }

  // AI: Long polling подходит для одной реплики worker; для нескольких - вебхуки за Caddy.
  void bot.start({ onStart: (me) => log.info(`telegram bot: @${me.username} polling`) });
  return bot;
}
