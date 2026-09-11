import type { TicketCard } from '@helpdesk/shared';

/**
 * AI: Интеграция с внешним helpdesk. Помощник собирает структурированную карточку; когда
 * пользователь соглашается на передачу, карточка становится настоящей заявкой в сервис-деске
 * организации, и специалист берёт её там - помощник никогда не «является» специалистом.
 *
 * Один интерфейс, одна реализация на систему. Добавить Jira / ServiceDesk Plus / 1С = один файл.
 */
export interface ExternalRequest {
  /** AI: Номер, который видит пользователь («102723») - тот же, что в интерфейсе helpdesk. */
  externalId: string;
  /** AI: Прямая ссылка на заявку в helpdesk (показывается в карточке). */
  url?: string;
}

export interface HelpdeskConnector {
  readonly kind: string;
  createRequest(
    card: TicketCard,
    context: { userDisplayName: string; transcript: string },
  ): Promise<ExternalRequest>;
  /**
   * AI: Пользователь отозвал заявку; необязательно - helpdesk без этого метода оставит её открытой.
   */
  closeRequest?(externalId: string, comment: string): Promise<void>;
}

/** AI: Dev / демо: внешней системы нет - вместо номера показывается короткий внутренний id. */
export class NoopHelpdesk implements HelpdeskConnector {
  readonly kind = 'none';
  async createRequest(card: TicketCard): Promise<ExternalRequest> {
    return { externalId: card.id.slice(0, 8).toUpperCase() };
  }
}

export interface NaumenOptions {
  /** AI: например https://help.tpu.ru */
  baseUrl: string;
  /** AI: Ключ доступа, выданный администратором Naumen SMP (пользователь REST API). */
  accessKey: string;
  /**
   * AI: Услуга (slmService$NNN), в которой создаётся заявка - можно добавить сопоставление по
   * категориям.
   */
  defaultServiceId: string;
  /** AI: Необязательно: id категории -> id slmService, чтобы заявка попадала в нужную очередь. */
  serviceByCategory?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/**
 * AI: Naumen Service Desk (платформа за help.tpu.ru). Использует SMP REST API:
 *   POST {base}/sd/services/rest/create/serviceCall?accessKey=...   тело = JSON атрибутов
 * Имена атрибутов (service, description, priority, client...) зависят от настройки метаклассов в
 * установке ТПУ - сверьте их с администратором Naumen; зафиксирован только транспорт.
 */
export class NaumenHelpdesk implements HelpdeskConnector {
  readonly kind = 'naumen';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: NaumenOptions) {
    this.fetchImpl = o.fetchImpl ?? globalThis.fetch;
  }

  async createRequest(
    card: TicketCard,
    ctx: { userDisplayName: string; transcript: string },
  ): Promise<ExternalRequest> {
    const service =
      (card.categoryId && this.o.serviceByCategory?.[card.categoryId]) || this.o.defaultServiceId;
    const description = [
      `Обращение создано виртуальным помощником.`,
      `Пользователь: ${ctx.userDisplayName}`,
      `Проблема: ${card.summary ?? '—'}`,
      `Категория помощника: ${card.categoryName ?? '—'} (уверенность ${card.confidence !== null ? Math.round(card.confidence * 100) + '%' : '—'})`,
      Object.keys(card.fields).length
        ? `Уточнения: ${Object.entries(card.fields)
            .map(([k, v]) => `${card.fieldLabels[k] ?? k} — ${v}`)
            .join('; ')}`
        : '',
      card.articleTitle ? `Предложенная статья: ${card.articleTitle}` : '',
      ``,
      `Диалог:`,
      ctx.transcript,
    ]
      .filter((l) => l !== '')
      .join('\n');

    const url = `${this.o.baseUrl.replace(/\/$/, '')}/sd/services/rest/create/serviceCall?accessKey=${encodeURIComponent(this.o.accessKey)}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service,
        shortDescr: (card.summary ?? 'Обращение из виртуального помощника').slice(0, 200),
        descriptionRTF: description,
        priority: card.priority === 'high' ? 'high' : card.priority === 'low' ? 'low' : 'normal',
        // AI: Ключ корреляции: позволяет helpdesk присылать обновления статуса в нужный чат.
        externalId: card.id,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`naumen: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    const data = (await res.json()) as { UUID?: string; number?: string | number; title?: string };
    const externalId = String(data.number ?? data.title ?? data.UUID ?? '');
    if (!externalId) throw new Error('naumen: response without request number');
    return {
      externalId,
      url: data.UUID
        ? `${this.o.baseUrl.replace(/\/$/, '')}/portal/serviceCall.html?uuid=${encodeURIComponent(data.UUID)}`
        : undefined,
    };
  }

  /**
   * AI: Пользователь отозвал заявку из чата: находим serviceCall по номеру и переводим в закрытое
   * состояние с причиной пользователя как резолюцией. Имена атрибутов (state, resolutionRTF) - с
   * той же оговоркой, что у createRequest: сверить с администратором.
   */
  async closeRequest(externalId: string, comment: string): Promise<void> {
    const base = this.o.baseUrl.replace(/\/$/, '');
    const key = encodeURIComponent(this.o.accessKey);
    const find = await this.fetchImpl(
      `${base}/sd/services/rest/find/serviceCall/${encodeURIComponent(JSON.stringify({ number: externalId }))}?accessKey=${key}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!find.ok) throw new Error(`naumen: find HTTP ${find.status}`);
    const [found] = (await find.json()) as Array<{ UUID?: string }>;
    if (!found?.UUID) throw new Error(`naumen: request ${externalId} not found`);
    const res = await this.fetchImpl(
      `${base}/sd/services/rest/edit/${found.UUID}?accessKey=${key}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'closed', resolutionRTF: comment }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new Error(`naumen: edit HTTP ${res.status}`);
  }
}
