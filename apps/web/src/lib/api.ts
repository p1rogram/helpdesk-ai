import type {
  DocPassage,
  AuthResponse,
  ChatMessage,
  ChatStreamEvent,
  KbSearchResult,
  TicketCard,
} from '@helpdesk/shared';

const TOKEN_KEY = 'helpdesk.token';

/**
 * AI: Тонкий типизированный клиент. На сайте JWT хранится в localStorage, чтобы перезагрузка
 * страницы сохраняла сессию (сам токен короткоживущий и проверяется сервером); внутри мессенджера
 * платформа проходит вход заново при каждом открытии, поэтому там ничего не сохраняется.
 */
export class ApiClient {
  private token: string | null = null;

  constructor(
    private readonly base = '',
    private readonly persist = false,
  ) {
    if (persist) {
      try {
        this.token = localStorage.getItem(TOKEN_KEY);
      } catch {
        this.token = null;
      }
    }
  }

  private remember() {
    if (!this.persist) return;
    try {
      if (this.token) localStorage.setItem(TOKEN_KEY, this.token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* хранилище недоступно */
    }
  }

  logout() {
    this.token = null;
    this.remember();
  }

  get authenticated() {
    return this.token !== null;
  }

  /** AI: Принять токен, выданный вне обычного потока (SSO-callback кладёт его во фрагмент URL). */
  setToken(token: string) {
    this.token = token;
    this.remember();
  }

  providers() {
    return this.get<{
      providers: {
        telegram: boolean;
        vk: boolean;
        max: boolean;
        guest: boolean;
        demo: boolean;
        sso: boolean;
        ldap: boolean;
        email: boolean;
      };
      ssoLabel: string;
      emailDomains: string[];
    }>('/api/auth/providers');
  }

  async loginLdap(login: string, password: string) {
    const r = await this.post<{ token: string }>('/api/auth/ldap', { login, password });
    this.token = r.token;
    this.remember();
  }

  requestEmailCode(email: string) {
    return this.post<{ ok: boolean }>('/api/auth/email/request', { email });
  }

  async verifyEmailCode(email: string, code: string) {
    const r = await this.post<{ token: string }>('/api/auth/email/verify', { email, code });
    this.token = r.token;
    this.remember();
  }

  async loginTelegram(initData: string, tenant?: string): Promise<AuthResponse> {
    const r = await this.post<AuthResponse>(
      `/api/auth/telegram${tenant ? `?tenant=${tenant}` : ''}`,
      { initData },
    );
    this.token = r.token;
    this.remember();
    return r;
  }

  /** AI: VK / MAX: непрозрачный подписанный payload от хост-приложения. */
  async loginPlatform(
    platform: 'vk' | 'max',
    payload: string,
    tenant?: string,
  ): Promise<AuthResponse> {
    const r = await this.post<AuthResponse>(
      `/api/auth/${platform}${tenant ? `?tenant=${tenant}` : ''}`,
      { payload },
    );
    this.token = r.token;
    this.remember();
    return r;
  }

  async loginDev(
    name: string,
    tenant?: string,
    scope: 'guest' | 'full' = 'full',
  ): Promise<AuthResponse> {
    const r = await this.post<AuthResponse>(`/api/auth/dev${tenant ? `?tenant=${tenant}` : ''}`, {
      name,
      scope,
    });
    this.token = r.token;
    this.remember();
    return r;
  }

  me() {
    return this.get<{
      id: string;
      platform: string;
      displayName: string;
      tenant: string;
      scope: 'guest' | 'full';
      isAdmin: boolean;
    }>('/api/me');
  }

  operatorTickets() {
    return this.get<{
      tickets: Array<
        TicketCard & {
          user: { displayName: string; platform: string };
          lastMessageAt: string | null;
          unanswered: boolean;
          /** AI: 0 - в работе, 1 - ждёт первого ответа, 2 - закрыто. */
          group: 0 | 1 | 2;
        }
      >;
    }>('/api/operator/tickets');
  }

  /** AI: Вернуть тикет помощнику (специалист не нужен). */
  operatorHandback(id: string) {
    return this.post<{ ticket: TicketCard }>(`/api/operator/tickets/${id}/handback`, {});
  }

  /**
   * AI: Живые обновления очереди. Вызывает `onChange` при любом изменении в очереди этого тенанта.
   */
  operatorStream(onChange: (ticketId: string | null) => void, signal: AbortSignal): void {
    const run = async () => {
      while (!signal.aborted) {
        try {
          // AI: POST, а не GET: CDN-туннели (Cloudflare) буферизуют тела GET ради решений о
          // кэшировании и придерживают SSE-кадры; ответ на POST стримится без изменений.
          const res = await fetch(`${this.base}/api/operator/stream`, {
            method: 'POST',
            headers: this.headers({ accept: 'text/event-stream' }),
            signal,
          });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const ev = JSON.parse(line.slice(5)) as { type: string; ticketId?: string | null };
                if (ev.type === 'queue') onChange(ev.ticketId ?? null);
              }
            }
          }
        } catch {
          /* соединение оборвалось - повтор ниже */
        }
        if (signal.aborted) return;
        // AI: Переподключение после короткой паузы (перезапуск сервера, таймаут прокси, уснувший
        // ноутбук).
        await new Promise((r) => setTimeout(r, 3000));
      }
    };
    void run();
  }

  operatorTicket(id: string) {
    return this.get<{
      ticket: TicketCard;
      user: { displayName: string; platform: string } | null;
      messages: ChatMessage[];
    }>(`/api/operator/tickets/${id}`);
  }

  operatorReply(id: string, text: string) {
    return this.post<{ message: ChatMessage }>(`/api/operator/tickets/${id}/reply`, { text });
  }

  operatorClose(id: string) {
    return this.post<{ ticket: TicketCard }>(`/api/operator/tickets/${id}/close`, {});
  }

  tenants() {
    return this.get<{
      tenants: Array<{ id: string; sphere: string }>;
      default: string;
      botUrl?: string;
    }>('/api/tenants');
  }

  /** AI: Открывает текущий тикет (сервер переиспользует открытый); `fresh` создаёт новый. */
  openTicket(fresh = false) {
    return this.post<{ ticket: TicketCard; messages: ChatMessage[] }>(
      `/api/tickets${fresh ? '?new=1' : ''}`,
      {},
    );
  }

  listTickets() {
    return this.get<{ tickets: TicketCard[] }>('/api/tickets');
  }

  getTicket(id: string) {
    return this.get<{ ticket: TicketCard; messages: ChatMessage[] }>(`/api/tickets/${id}`);
  }

  rate(id: string, rating: number) {
    return this.post<{ ticket: TicketCard; message: ChatMessage }>(`/api/tickets/${id}/rating`, {
      rating,
    });
  }

  /** AI: Пользователь отзывает обращение (работает и пока оно у специалиста). */
  closeTicket(id: string) {
    return this.post<{ ticket: TicketCard; message: ChatMessage }>(`/api/tickets/${id}/close`, {});
  }

  searchKb(q: string) {
    return this.get<{ results: KbSearchResult[]; docs: DocPassage[] }>(
      `/api/kb/search?q=${encodeURIComponent(q)}`,
    );
  }

  categories() {
    return this.get<{
      tenant: { id: string; sphere: string };
      categories: Array<{ id: string; name: string }>;
    }>('/api/kb/categories');
  }

  /** AI: POST + SSE через fetch (EventSource умеет только GET). Выдаёт разобранные события. */
  async *sendMessage(
    ticketId: string,
    text: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent> {
    const res = await fetch(`${this.base}/api/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', accept: 'text/event-stream' }),
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok || !res.body) throw new ApiError(res.status, await safeText(res));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) yield JSON.parse(line.slice(5)) as ChatStreamEvent;
        }
      }
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { ...extra, authorization: `Bearer ${this.token}` } : extra;
  }

  private async get<T>(path: string): Promise<T> {
    const r = await fetch(this.base + path, { headers: this.headers() });
    if (r.status === 401) this.logout();
    if (!r.ok) throw new ApiError(r.status, await safeText(r));
    return (await r.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(this.base + path, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new ApiError(r.status, await safeText(r));
    return (await r.json()) as T;
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return '';
  }
}
