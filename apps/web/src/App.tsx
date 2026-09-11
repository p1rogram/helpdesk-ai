import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient } from './lib/api';
import { detectPlatform, type PlatformAdapter } from './lib/platform';
import {
  applyTheme,
  getThemeMode,
  setThemeMode,
  watchSystemTheme,
  type ThemeMode,
} from './lib/theme';
import { installSoundHooks } from './lib/sound';
import { useSwipeNavigation } from './lib/swipe';
import { BottomNav, type NavItem } from './components/BottomNav';
import { Icon } from './components/Icon';
import { ChatScreen } from './screens/ChatScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { KbScreen } from './screens/KbScreen';
import { LoginScreen } from './screens/LoginScreen';
import { OperatorScreen } from './screens/OperatorScreen';
import { ProfileScreen } from './screens/ProfileScreen';

type Tab = 'chat' | 'history' | 'kb' | 'operator' | 'profile';

export function App() {
  const platform = useMemo<PlatformAdapter>(() => detectPlatform(), []);
  const api = useMemo(() => new ApiClient('', platform.kind === 'web'), [platform]);
  const urlTenant = useMemo(
    () => new URLSearchParams(window.location.search).get('tenant') ?? undefined,
    [],
  );

  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(platform.kind === 'web' && api.authenticated);

  // AI: Вкладка живёт в адресе (#/chat, #/history, ...): кнопки «назад / вперёд» браузера
  // и ссылки на вкладку работают как в обычном сайте, а в Mini App это ничему не мешает.
  const [tab, setTab] = useState<Tab>(() => tabFromHash() ?? 'chat');
  useEffect(() => {
    const onHash = () => {
      const next = tabFromHash();
      if (next) setTab(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (window.location.hash !== `#/${tab}` && !window.location.hash.includes('token='))
      history.pushState(null, '', `#/${tab}`);
  }, [tab]);
  // AI: На широком экране история показывается рядом с чатом, а вкладки - боковой полосой.
  const desktop = useMediaQuery('(min-width: 1000px)');
  // AI: -1 / 1 - в какую сторону было последнее переключение, чтобы новая панель въезжала с той
  // стороны.
  const [slide, setSlide] = useState<1 | -1>(1);
  const [openTicketId, setOpenTicketId] = useState<string | undefined>(undefined);
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
      /* игнорируем */
    }
  };
  const [historyVersion, setHistoryVersion] = useState(0);

  const [sphere, setSphere] = useState('');
  const [botUrl, setBotUrl] = useState<string | undefined>(undefined);
  const [displayName, setDisplayName] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [scope, setScope] = useState<'guest' | 'full'>('full');
  const screenRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------- тема ---
  const [theme, setTheme] = useState<ThemeMode>(getThemeMode);
  const refreshTheme = useCallback(
    (mode: ThemeMode) => {
      const hostDark = mode === 'auto' ? platform.isDark() : false;
      applyTheme(mode, hostDark);
    },
    [platform],
  );
  useEffect(() => {
    refreshTheme(theme);
    return watchSystemTheme(() => refreshTheme(theme));
  }, [theme, refreshTheme]);
  const changeTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    setTheme(mode);
  };
  const cycleTheme = () =>
    changeTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'auto' : 'light');

  // AI: У продукта своя палитра; от хоста берём только светлое/тёмное (см. refreshTheme).
  useEffect(() => {
    platform.ready();
    platform.expand();
  }, [platform]);
  useEffect(() => installSoundHooks(), []);

  // ----------------------------------------------------------------- вход ---
  useEffect(() => {
    if (!restoring) return;
    api
      .me()
      .then(() => setAuthed(true))
      .catch(() => api.logout())
      .finally(() => setRestoring(false));
  }, [api, restoring]);

  useEffect(() => {
    const m = /[#&]token=([^&]+)/.exec(window.location.hash);
    if (m?.[1]) {
      api.setToken(decodeURIComponent(m[1]));
      history.replaceState(null, '', window.location.pathname);
      setAuthed(true);
    }
  }, [api]);

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
      .catch((e: Error) =>
        setAuthError(`Не удалось подтвердить сессию (${platform.kind}): ${e.message}`),
      );
  }, [api, platform, urlTenant]);

  useEffect(() => {
    api
      .tenants()
      .then((r) => {
        const t = r.tenants.find((x) => x.id === (urlTenant ?? r.default)) ?? r.tenants[0];
        if (t) setSphere(t.sphere);
        setBotUrl(r.botUrl);
      })
      .catch(() => {});
  }, [api, urlTenant]);

  useEffect(() => {
    if (!authed) return;
    api
      .me()
      .then((m) => {
        setIsAdmin(m.isAdmin);
        setDisplayName(m.displayName);
        setScope(m.scope);
      })
      .catch(() => {});
    api
      .categories()
      .then((r) => setSphere(r.tenant.sphere))
      .catch(() => {});
  }, [api, authed]);

  // AI: Свайп влево/вправо переключает нижние вкладки; хук игнорирует преимущественно вертикальные
  // жесты и всё, что началось внутри горизонтально прокручиваемой полосы.
  const tabKeys = useMemo<Tab[]>(
    () =>
      isAdmin
        ? ['chat', 'history', 'kb', 'operator', 'profile']
        : ['chat', 'history', 'kb', 'profile'],
    [isAdmin],
  );
  const goToTab = useCallback(
    (next: Tab) =>
      setTab((current) => {
        if (next === current) return current;
        setSlide(tabKeys.indexOf(next) > tabKeys.indexOf(current) ? 1 : -1);
        return next;
      }),
    [tabKeys],
  );
  const swipeTo = useCallback(
    (direction: 1 | -1) =>
      setTab((current) => {
        const next = tabKeys.indexOf(current) + direction;
        if (next < 0 || next >= tabKeys.length) return current;
        setSlide(direction);
        return tabKeys[next]!;
      }),
    [tabKeys],
  );
  useSwipeNavigation(screenRef, swipeTo, authed);

  // ---------------------------------------------------------------- рендер --
  if (restoring) {
    return (
      <div className="app">
        <div className="empty">Загрузка…</div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="app">
        <Header
          sphere={sphere}
          online={false}
          theme={theme}
          onToggleTheme={cycleTheme}
          onOpenProfile={() => {}}
          showProfile={false}
        />
        <LoginScreen
          api={api}
          platform={platform}
          tenant={urlTenant}
          botUrl={botUrl}
          error={authError}
          onLoggedIn={() => {
            setAuthError(null);
            setAuthed(true);
          }}
        />
      </div>
    );
  }

  const LABELS: Record<Tab, { label: string; icon: NavItem['icon'] }> = {
    chat: { label: 'Чат', icon: 'chat' },
    history: { label: 'История', icon: 'history' },
    kb: { label: 'База знаний', icon: 'book' },
    operator: { label: 'Оператор', icon: 'shield' },
    profile: { label: 'Профиль', icon: 'user' },
  };
  const items: NavItem[] = tabKeys.map((k) => ({ key: k, ...LABELS[k] }));
  const paneClass = `pane slide-${slide > 0 ? 'left' : 'right'}`;

  return (
    <div className={`app${tab === 'operator' ? ' wide' : ''}${desktop ? ' desktop' : ''}`}>
      <Header
        sphere={sphere}
        online
        theme={theme}
        onToggleTheme={cycleTheme}
        onOpenProfile={() => setTab('profile')}
        showProfile
      />

      {/* AI: Каждая вкладка остаётся смонтированной и хранит своё состояние (прокрутка, черновики, живые подписки); переключение лишь меняет видимость, поэтому ничего не перезапрашивается и не рендерится с нуля. */}
      <div className="screen" ref={screenRef} data-tab={tab}>
        <div className={`${paneClass} chat-pane`} hidden={tab !== 'chat'}>
          <ChatScreen
            api={api}
            platform={platform}
            ticketId={openTicketId ?? currentTicket}
            onTicketChange={(id) => {
              setCurrentTicket(id);
              setOpenTicketId(undefined);
              setHistoryVersion((v) => v + 1);
            }}
            onTicketUpdate={() => setHistoryVersion((v) => v + 1)}
          />
        </div>
        <div
          className={`${paneClass} history-pane${desktop && tab === 'chat' ? ' side' : ''}`}
          hidden={tab !== 'history' && !(desktop && tab === 'chat')}
        >
          <HistoryScreen
            api={api}
            active={tab === 'history' || (desktop && tab === 'chat')}
            refreshKey={historyVersion}
            activeId={openTicketId ?? currentTicket}
            onOpen={(id) => {
              setOpenTicketId(id);
              setTab('chat');
            }}
          />
        </div>
        <div className={paneClass} hidden={tab !== 'kb'}>
          <KbScreen api={api} />
        </div>
        {isAdmin && (
          <div className={paneClass} hidden={tab !== 'operator'}>
            <OperatorScreen api={api} />
          </div>
        )}
        <div className={paneClass} hidden={tab !== 'profile'}>
          <ProfileScreen
            platform={platform}
            displayName={displayName}
            sphere={sphere}
            isAdmin={isAdmin}
            scope={scope}
            theme={theme}
            onTheme={changeTheme}
            onLogout={
              platform.kind === 'web'
                ? () => {
                    api.logout();
                    setCurrentTicket(undefined);
                    setAuthed(false);
                  }
                : undefined
            }
          />
        </div>
      </div>

      <BottomNav items={items} active={tab} onSelect={(k) => goToTab(k as Tab)} />
    </div>
  );
}

const TABS: Tab[] = ['chat', 'history', 'kb', 'operator', 'profile'];
function tabFromHash(): Tab | undefined {
  const m = /^#\/([a-z]+)/.exec(window.location.hash);
  return m && (TABS as string[]).includes(m[1]!) ? (m[1] as Tab) : undefined;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [query]);
  return matches;
}

function Header(props: {
  sphere: string;
  online: boolean;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onOpenProfile: () => void;
  showProfile: boolean;
}) {
  const themeIcon = props.theme === 'light' ? 'sun' : props.theme === 'dark' ? 'moon' : 'auto';
  return (
    <header className="topbar">
      <span className="brand">
        <Icon name="bot" size={20} />
      </span>
      <div className="titles">
        <div className="title">Помоги мне</div>
        <div className="sub">
          <span className={`dot${props.online ? '' : ' off'}`} />
          {props.sphere.replace(/^Техническая поддержка /, '') || 'Виртуальная поддержка'}
        </div>
      </div>
      <button
        className="icon-btn"
        onClick={props.onToggleTheme}
        title={`Тема: ${props.theme === 'auto' ? 'авто' : props.theme === 'dark' ? 'тёмная' : 'светлая'}`}
        aria-label="Переключить тему"
      >
        <Icon name={themeIcon} size={18} />
      </button>
      {props.showProfile && (
        <button className="icon-btn" onClick={props.onOpenProfile} aria-label="Профиль">
          <Icon name="user" size={18} />
        </button>
      )}
    </header>
  );
}
