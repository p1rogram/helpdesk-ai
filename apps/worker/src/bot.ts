import { Bot, InlineKeyboard } from 'grammy';
import type { Logger } from 'pino';

/**
 * The Telegram bot is deliberately thin: it opens the Mini App and delivers notifications.
 * All dialogue happens inside the Mini App (rich UI, streaming, buttons) - the bot API is
 * only the transport for push messages.
 *
 * Networking: uses Node's global fetch. If api.telegram.org is reachable only through a proxy,
 * run with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY=... (Node >= 24) - no code changes needed.
 */
export async function startBot(token: string, webAppUrl: string | undefined, log: Logger): Promise<Bot> {
  // grammY defaults to its own node-fetch shim (polyfilled AbortSignal, `compress` option) which the
  // native fetch rejects. Use the global fetch - it honours NODE_USE_ENV_PROXY - with a native timeout.
  const nativeFetch: typeof fetch = (url, init) => {
    const { signal: _polyfilled, compress: _c, ...rest } = (init ?? {}) as RequestInit & { compress?: boolean };
    return globalThis.fetch(url, { ...rest, signal: AbortSignal.timeout(35_000) });
  };
  const bot = new Bot(token, { client: { timeoutSeconds: 30, fetch: nativeFetch } });

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
    await ctx.reply('Опишите проблему в приложении — так я смогу задать уточнения и показать пошаговое решение.', {
      reply_markup: kb,
    });
  });

  bot.catch((err) => log.error({ err: err.error }, 'telegram bot error'));

  // Verify the token up front so a misconfiguration is visible at startup, not on first message.
  try {
    const me = await bot.api.getMe();
    log.info(`telegram bot: @${me.username} connected`);
  } catch (err) {
    // Never log the raw error: grammY embeds the bot token in request URLs.
    const reason = err instanceof Error ? err.message.replace(/bot\d+:[\w-]+/g, 'bot***') : String(err);
    log.error({ reason }, 'telegram bot: cannot reach api.telegram.org (check token / proxy: NODE_USE_ENV_PROXY=1)');
    return bot;
  }

  // Long polling is fine for a single worker replica; switch to webhooks behind Caddy for many.
  void bot.start({ onStart: (me) => log.info(`telegram bot: @${me.username} polling`) });
  return bot;
}
