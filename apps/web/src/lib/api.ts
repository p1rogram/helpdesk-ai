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
 * AI: Thin typed client. On the website the JWT is kept in localStorage so a page refresh keeps the
 * session (the token itself is short-lived and verified server-side); inside a messenger the
 * platform re-authenticates on every open, so nothing is persisted there.
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
      /* storage unavailable */
    }
  }

  logout() {
    this.token = null;
    this.remember();
  }

  get authenticated() {
    return this.token !== null;
  }

  /** AI: Adopt a token issued out-of-band (SSO callback puts it in the URL fragment). */
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

  /** AI: VK / MAX: opaque signed payload from the host app. */
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
          /** AI: 0 - in progress, 1 - waiting for first reply, 2 - closed. */
          group: 0 | 1 | 2;
        }
      >;
    }>('/api/operator/tickets');
  }

  /** AI: Hand the ticket back to the assistant (no specialist needed). */
  operatorHandback(id: string) {
    return this.post<{ ticket: TicketCard }>(`/api/operator/tickets/${id}/handback`, {});
  }

  /** AI: Live queue updates. Calls `onChange` whenever anything in this tenant's queue changes. */
  operatorStream(onChange: (ticketId: string | null) => void, signal: AbortSignal): void {
    const run = async () => {
      while (!signal.aborted) {
        try {
          // AI: POST, not GET: CDN tunnels (Cloudflare) buffer GET bodies for cache decisions and
          // hold SSE frames back; a POST response streams through untouched.
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
          /* connection dropped - retry below */
        }
        if (signal.aborted) return;
        // AI: Reconnect after a short pause (server restart, proxy timeout, sleeping laptop).
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

  /** AI: Opens the current ticket (server reuses an open one); `fresh` forces a new ticket. */
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

  /** AI: The user withdraws the request (works while a specialist has it, too). */
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

  /** AI: POST + SSE over fetch (EventSource is GET-only). Yields parsed events. */
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
