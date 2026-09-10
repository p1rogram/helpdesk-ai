import type {
  AuthResponse,
  ChatMessage,
  ChatStreamEvent,
  KbSearchResult,
  TicketCard,
} from '@helpdesk/shared';

/** Thin typed client. The JWT lives in memory only (not localStorage) - closing the app logs out. */
export class ApiClient {
  private token: string | null = null;

  constructor(private readonly base = '') {}

  get authenticated() {
    return this.token !== null;
  }

  /** Adopt a token issued out-of-band (SSO callback puts it in the URL fragment). */
  setToken(token: string) {
    this.token = token;
  }

  providers() {
    return this.get<{
      providers: { telegram: boolean; vk: boolean; max: boolean; guest: boolean; sso: boolean; ldap: boolean; email: boolean };
      ssoLabel: string;
      emailDomains: string[];
    }>('/api/auth/providers');
  }

  async loginLdap(login: string, password: string) {
    const r = await this.post<{ token: string }>('/api/auth/ldap', { login, password });
    this.token = r.token;
  }

  requestEmailCode(email: string) {
    return this.post<{ ok: boolean }>('/api/auth/email/request', { email });
  }

  async verifyEmailCode(email: string, code: string) {
    const r = await this.post<{ token: string }>('/api/auth/email/verify', { email, code });
    this.token = r.token;
  }

  async loginTelegram(initData: string, tenant?: string): Promise<AuthResponse> {
    const r = await this.post<AuthResponse>(`/api/auth/telegram${tenant ? `?tenant=${tenant}` : ''}`, { initData });
    this.token = r.token;
    return r;
  }

  /** VK / MAX: opaque signed payload from the host app. */
  async loginPlatform(platform: 'vk' | 'max', payload: string, tenant?: string): Promise<AuthResponse> {
    const r = await this.post<AuthResponse>(`/api/auth/${platform}${tenant ? `?tenant=${tenant}` : ''}`, { payload });
    this.token = r.token;
    return r;
  }

  async loginDev(name: string, tenant?: string): Promise<AuthResponse> {
    const r = await this.post<AuthResponse>(`/api/auth/dev${tenant ? `?tenant=${tenant}` : ''}`, { name });
    this.token = r.token;
    return r;
  }

  me() {
    return this.get<{ id: string; platform: string; displayName: string; tenant: string; isAdmin: boolean }>('/api/me');
  }

  operatorTickets() {
    return this.get<{ tickets: Array<TicketCard & { user: { displayName: string; platform: string }; lastMessageAt: string | null; unanswered: boolean }> }>(
      '/api/operator/tickets',
    );
  }

  operatorTicket(id: string) {
    return this.get<{ ticket: TicketCard; user: { displayName: string; platform: string } | null; messages: ChatMessage[] }>(
      `/api/operator/tickets/${id}`,
    );
  }

  operatorReply(id: string, text: string) {
    return this.post<{ message: ChatMessage }>(`/api/operator/tickets/${id}/reply`, { text });
  }

  operatorClose(id: string) {
    return this.post<{ ticket: TicketCard }>(`/api/operator/tickets/${id}/close`, {});
  }

  tenants() {
    return this.get<{ tenants: Array<{ id: string; sphere: string }>; default: string; botUrl?: string }>('/api/tenants');
  }

  /** Opens the current ticket (server reuses an open one); `fresh` forces a new ticket. */
  openTicket(fresh = false) {
    return this.post<{ ticket: TicketCard; messages: ChatMessage[] }>(`/api/tickets${fresh ? '?new=1' : ''}`, {});
  }

  listTickets() {
    return this.get<{ tickets: TicketCard[] }>('/api/tickets');
  }

  getTicket(id: string) {
    return this.get<{ ticket: TicketCard; messages: ChatMessage[] }>(`/api/tickets/${id}`);
  }

  rate(id: string, rating: number) {
    return this.post<{ ticket: TicketCard }>(`/api/tickets/${id}/rating`, { rating });
  }

  searchKb(q: string) {
    return this.get<{ results: KbSearchResult[] }>(`/api/kb/search?q=${encodeURIComponent(q)}`);
  }

  categories() {
    return this.get<{ tenant: { id: string; sphere: string }; categories: Array<{ id: string; name: string }> }>(
      '/api/kb/categories',
    );
  }

  /** POST + SSE over fetch (EventSource is GET-only). Yields parsed events. */
  async *sendMessage(ticketId: string, text: string, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
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
