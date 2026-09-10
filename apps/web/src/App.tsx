import { useEffect, useMemo, useState } from 'react';
import { ApiClient } from './lib/api';
import { detectPlatform, type PlatformAdapter } from './lib/platform';
import { ChatScreen } from './screens/ChatScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { KbScreen } from './screens/KbScreen';
import { LoginScreen } from './screens/LoginScreen';

type Screen = { name: 'chat'; ticketId?: string } | { name: 'history' } | { name: 'kb' };

export function App() {
  const platform = useMemo<PlatformAdapter>(() => detectPlatform(), []);
  const api = useMemo(() => new ApiClient(''), []);
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'chat' });
  const [sphere, setSphere] = useState('');
  const [currentTicket, setCurrentTicket] = useState<string | undefined>(undefined);

  // Apply host theme (Telegram colours) and expand the Mini App.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = platform.isDark() ? 'dark' : 'light';
    for (const [k, v] of Object.entries(platform.themeVars())) root.style.setProperty(k, v);
    platform.ready();
    platform.expand();
  }, [platform]);

  // Telegram: silent login with signed initData. Web: show the guest login form.
  useEffect(() => {
    const payload = platform.authPayload();
    if (!payload) return;
    api
      .loginTelegram(payload)
      .then(() => setAuthed(true))
      .catch((e: Error) => setAuthError(`Не удалось подтвердить сессию Telegram: ${e.message}`));
  }, [api, platform]);

  useEffect(() => {
    if (!authed) return;
    api.categories().then((r) => setSphere(r.tenant.sphere)).catch(() => {});
  }, [api, authed]);

  if (!authed) {
    return (
      <div className="app">
        <LoginScreen
          api={api}
          platform={platform}
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
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="title">Помощник поддержки</div>
          <div className="sub">{sphere || '…'}</div>
        </div>
        <button className={`iconbtn ${screen.name === 'chat' ? 'active' : ''}`} onClick={() => setScreen({ name: 'chat' })}>
          Чат
        </button>
        <button
          className={`iconbtn ${screen.name === 'history' ? 'active' : ''}`}
          onClick={() => setScreen({ name: 'history' })}
        >
          История
        </button>
        <button className={`iconbtn ${screen.name === 'kb' ? 'active' : ''}`} onClick={() => setScreen({ name: 'kb' })}>
          База знаний
        </button>
      </header>
      {screen.name === 'chat' && (
        <ChatScreen
          api={api}
          platform={platform}
          ticketId={screen.ticketId ?? currentTicket}
          onTicketChange={setCurrentTicket}
        />
      )}
      {screen.name === 'history' && <HistoryScreen api={api} onOpen={(id) => setScreen({ name: 'chat', ticketId: id })} />}
      {screen.name === 'kb' && <KbScreen api={api} />}
    </div>
  );
}
