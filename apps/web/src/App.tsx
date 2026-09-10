import { useEffect, useMemo, useState } from 'react';
import { ApiClient } from './lib/api';
import { detectPlatform, type PlatformAdapter } from './lib/platform';
import { ChatScreen } from './screens/ChatScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { KbScreen } from './screens/KbScreen';
import { LoginScreen } from './screens/LoginScreen';
import { LandingScreen } from './screens/LandingScreen';
import { OperatorScreen } from './screens/OperatorScreen';

type Screen = { name: 'chat'; ticketId?: string } | { name: 'history' } | { name: 'kb' } | { name: 'operator' };

export function App() {
  const platform = useMemo<PlatformAdapter>(() => detectPlatform(), []);
  const api = useMemo(() => new ApiClient('', platform.kind === 'web'), [platform]);
  const urlTenant = useMemo(() => new URLSearchParams(window.location.search).get('tenant') ?? undefined, []);
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'chat' });
  const [sphere, setSphere] = useState('');
  const [currentTicket, setCurrentTicketState] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem('helpdesk.ticket') ?? undefined;
    } catch {
      return undefined;
    }
  });
  const setCurrentTicket = (id: string | undefined) => {
    setCurrentTicketState(id);
    try {
      if (id) localStorage.setItem('helpdesk.ticket', id);
      else localStorage.removeItem('helpdesk.ticket');
    } catch {
      /* ignore */
    }
  };
  const [restoring, setRestoring] = useState(platform.kind === 'web' && api.authenticated);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showLanding, setShowLanding] = useState(true);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [botUrl, setBotUrl] = useState<string | undefined>(undefined);

  // Apply host theme (Telegram colours) and expand the Mini App.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = platform.isDark() ? 'dark' : 'light';
    for (const [k, v] of Object.entries(platform.themeVars())) root.style.setProperty(k, v);
    platform.ready();
    platform.expand();
  }, [platform]);

  // Website: a stored session survives page refresh - validate it once, then continue where the user was.
  useEffect(() => {
    if (!restoring) return;
    api
      .me()
      .then(() => setAuthed(true))
      .catch(() => api.logout())
      .finally(() => setRestoring(false));
  }, [api, restoring]);

  // SSO callback: the token arrives in the URL fragment (never hits server logs).
  useEffect(() => {
    const m = /[#&]token=([^&]+)/.exec(window.location.hash);
    if (m?.[1]) {
      api.setToken(decodeURIComponent(m[1]));
      history.replaceState(null, '', window.location.pathname);
      setAuthed(true);
    }
  }, [api]);

  // Telegram: silent login with signed initData. Web: show the guest login form.
  useEffect(() => {
    const payload = platform.authPayload();
    if (!payload) return;
    const login =
      platform.kind === 'telegram'
        ? api.loginTelegram(payload, urlTenant)
        : platform.kind === 'vk' || platform.kind === 'max'
          ? api.loginPlatform(platform.kind, payload)
          : null;
    if (!login) return;
    login
      .then(() => setAuthed(true))
      .catch((e: Error) => setAuthError(`Не удалось подтвердить сессию (${platform.kind}): ${e.message}`));
  }, [api, platform]);

  // Public info for the landing (no auth needed).
  useEffect(() => {
    api
      .tenants()
      .then((r) => {
        const t = r.tenants.find((x) => x.id === r.default) ?? r.tenants[0];
        if (t) setSphere(t.sphere);
        setBotUrl(r.botUrl);
      })
      .catch(() => {});
  }, [api]);

  useEffect(() => {
    if (!authed) return;
    api.categories().then((r) => setSphere(r.tenant.sphere)).catch(() => {});
    api.me().then((m) => setIsAdmin(m.isAdmin)).catch(() => {});
  }, [api, authed]);

  if (restoring) {
    return (
      <div className="app">
        <div className="empty">Загрузка…</div>
      </div>
    );
  }

  if (!authed && platform.kind === 'web' && showLanding && !window.location.hash.includes('token=')) {
    return <LandingScreen sphere={sphere} botUrl={botUrl} onStart={() => setShowLanding(false)} />;
  }

  if (!authed) {
    return (
      <div className="app">
        <LoginScreen
          api={api}
          platform={platform}
          tenant={urlTenant}
          error={authError}
          onLoggedIn={() => {
            setAuthError(null);
            setAuthed(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="titles">
          <div className="title">Помощник поддержки</div>
          <div className="sub" title={sphere}>
            {sphere.replace(/^Техническая поддержка /, '') || '…'}
          </div>
        </div>
        <nav className="tabs">
          <button className={screen.name === 'chat' ? 'active' : ''} onClick={() => setScreen({ name: 'chat' })}>
            Чат
          </button>
          <button className={screen.name === 'history' ? 'active' : ''} onClick={() => setScreen({ name: 'history' })}>
            История
          </button>
          <button className={screen.name === 'kb' ? 'active' : ''} onClick={() => setScreen({ name: 'kb' })}>
            Поиск
          </button>
          {isAdmin && (
            <button className={screen.name === 'operator' ? 'active' : ''} onClick={() => setScreen({ name: 'operator' })}>
              Оператор
            </button>
          )}
        </nav>
      </header>
      {screen.name === 'chat' && (
        <div className="chat-layout">
          <aside className="sidebar">
            <HistoryScreen
              api={api}
              compact
              refreshKey={historyVersion}
              activeId={screen.ticketId ?? currentTicket}
              onOpen={(id) => setScreen({ name: 'chat', ticketId: id })}
            />
          </aside>
          <div className="chat-main">
            <ChatScreen
              api={api}
              platform={platform}
              ticketId={screen.ticketId ?? currentTicket}
              onTicketChange={(id) => {
                setCurrentTicket(id);
                setHistoryVersion((v) => v + 1);
              }}
              onTicketUpdate={() => setHistoryVersion((v) => v + 1)}
            />
          </div>
        </div>
      )}
      {screen.name === 'history' && <HistoryScreen api={api} onOpen={(id) => setScreen({ name: 'chat', ticketId: id })} />}
      {screen.name === 'kb' && <KbScreen api={api} />}
      {screen.name === 'operator' && <OperatorScreen api={api} />}
    </div>
  );
}
