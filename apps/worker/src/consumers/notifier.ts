import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { NotificationEvent } from '@helpdesk/shared';

/** AI: Доставляет push-уведомления в тот мессенджер, откуда пришёл пользователь. */
export class NotifierConsumer {
  constructor(
    private readonly bot: Bot | null,
    private readonly log: Logger,
  ) {}

  async handle(e: NotificationEvent): Promise<void> {
    switch (e.platform) {
      case 'telegram': {
        if (!this.bot)
          return this.log.warn({ ticketId: e.ticketId }, 'notification skipped: bot disabled');
        await this.bot.api.sendMessage(Number(e.platformUserId), e.text);
        this.log.info({ ticketId: e.ticketId }, 'telegram notification sent');
        return;
      }
      // AI: Адаптеры VK / MAX подключаются здесь со своими API отправки.
      default:
        this.log.info(
          { ticketId: e.ticketId, platform: e.platform },
          'notification (no push channel for platform)',
        );
    }
  }
}
