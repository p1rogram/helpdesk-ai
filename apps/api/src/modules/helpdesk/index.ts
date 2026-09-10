import type { TicketCard } from '@helpdesk/shared';

/**
 * External helpdesk integration. The assistant collects a structured ticket card; when the user
 * agrees to escalate, the card becomes a real request in the organisation's service desk and a
 * specialist picks it up there - the assistant never "is" the specialist.
 *
 * One interface, one implementation per system. Adding Jira / ServiceDesk Plus / 1С = one file.
 */
export interface ExternalRequest {
  /** Number the user sees ("102723") - the same as in the helpdesk UI. */
  externalId: string;
  /** Deep link to the request in the helpdesk (shown in the card). */
  url?: string;
}

export interface HelpdeskConnector {
  readonly kind: string;
  createRequest(card: TicketCard, context: { userDisplayName: string; transcript: string }): Promise<ExternalRequest>;
}

/** Dev / demo: no external system - the internal short id is shown instead. */
export class NoopHelpdesk implements HelpdeskConnector {
  readonly kind = 'none';
  async createRequest(card: TicketCard): Promise<ExternalRequest> {
    return { externalId: card.id.slice(0, 8).toUpperCase() };
  }
}

export interface NaumenOptions {
  /** e.g. https://help.tpu.ru */
  baseUrl: string;
  /** Access key issued by the Naumen SMP administrator (REST API user). */
  accessKey: string;
  /** Service (slmService$NNN) the request is created in - a mapping per category can be added. */
  defaultServiceId: string;
  /** Optional: category id -> slmService id, so the request lands in the right queue. */
  serviceByCategory?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/**
 * Naumen Service Desk (the platform behind help.tpu.ru). Uses the SMP REST API:
 *   POST {base}/sd/services/rest/create/serviceCall?accessKey=...   body = attributes JSON
 * Attribute names (service, description, priority, client...) depend on the TPU installation's
 * metaclass configuration - confirm them with the Naumen administrator; only the transport is fixed.
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
    const service = (card.categoryId && this.o.serviceByCategory?.[card.categoryId]) || this.o.defaultServiceId;
    const description = [
      `Обращение создано виртуальным помощником.`,
      `Пользователь: ${ctx.userDisplayName}`,
      `Проблема: ${card.summary ?? '—'}`,
      `Категория помощника: ${card.categoryName ?? '—'} (уверенность ${card.confidence !== null ? Math.round(card.confidence * 100) + '%' : '—'})`,
      Object.keys(card.fields).length
        ? `Уточнения: ${Object.entries(card.fields)
            .map(([k, v]) => `${k} — ${v}`)
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
        // Correlation key: lets the helpdesk push status updates back to the right chat.
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
      url: data.UUID ? `${this.o.baseUrl.replace(/\/$/, '')}/portal/serviceCall.html?uuid=${encodeURIComponent(data.UUID)}` : undefined,
    };
  }
}
