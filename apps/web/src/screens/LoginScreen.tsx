import { useEffect, useState } from 'react';
import type { ApiClient } from '../lib/api';
import type { PlatformAdapter } from '../lib/platform';

type Providers = { guest: boolean; sso: boolean; ldap: boolean; email: boolean };
type Mode = 'menu' | 'ldap' | 'email' | 'guest' | 'student';
const MODES = ['sso', 'ldap', 'email', 'guest'] as const;

/**
 * AI: Browser login. Inside a messenger the login is silent; here the user picks what the
 * organisation enabled: SSO (redirect), domain login/password (LDAP), e-mail code, or guest demo.
 */
export function LoginScreen(props: {
  api: ApiClient;
  platform: PlatformAdapter;
  /** AI: Sphere override from the URL (?tenant=...); default sphere otherwise. */
  tenant?: string;
  error: string | null;
  onLoggedIn: () => void;
}) {
  const { api } = props;
  const [providers, setProviders] = useState<Providers | null>(null);
  const [ssoLabel, setSsoLabel] = useState('Войти через учётную запись');
  const [domains, setDomains] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>('menu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(props.error);
  const [name, setName] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);

  useEffect(() => {
    api
      .providers()
      .then((p) => {
        setProviders(p.providers);
        setSsoLabel(p.ssoLabel);
        setDomains(p.emailDomains);
        // AI: A single non-SSO provider opens directly.
        const enabled = MODES.filter((k) => p.providers[k]);
        const only = enabled.length === 1 && enabled[0] !== 'guest' ? enabled[0] : undefined;
        if (only && only !== 'sso') setMode(only);
      })
      .catch(() => setProviders({ guest: true, sso: false, ldap: false, email: false }));
  }, [api]);

  if (props.platform.kind !== 'web') {
    return <div className="login">{props.error ? <div className="error">{props.error}</div> : <div className="empty">Подключение…</div>}</div>;
  }
  if (!providers) {
    return (
      <div className="login">
        <div className="empty">Загрузка…</div>
      </div>
    );
  }

  const run = async (fn: () => Promise<void>, failMessage: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch {
      setError(failMessage);
    } finally {
      setBusy(false);
    }
  };

  const enabledCount = MODES.filter((k) => providers[k]).length;

  return (
    <div className="login">
      <h2 style={{ margin: 0 }}>Помощник поддержки</h2>

      {mode === 'menu' && (
        <>
          <div className="sub" style={{ color: 'var(--muted)' }}>
            Выберите способ входа.
          </div>
          {providers.sso && (
            <a className="btn-primary" href={`/api/auth/sso/start?returnTo=${encodeURIComponent(window.location.href)}`}>
              {ssoLabel}
            </a>
          )}
          {providers.ldap && <button onClick={() => setMode('ldap')}>Логин и пароль организации</button>}
          {providers.email && <button onClick={() => setMode('email')}>Код на корпоративную почту</button>}
          {providers.guest && (
            <>
              <button onClick={() => setMode('student')}>Я студент или сотрудник ТПУ</button>
              <button className="btn-secondary" onClick={() => setMode('guest')}>
                Я гость — вопросы о поступлении и контакты
              </button>
            </>
          )}
          {enabledCount === 0 && <div className="empty">Вход в браузере не настроен. Откройте помощника из Telegram.</div>}
        </>
      )}

      {mode === 'ldap' && (
        <>
          <div className="sub" style={{ color: 'var(--muted)' }}>
            Те же логин и пароль, что для Wi-Fi, почты и Moodle. Пароль проверяется доменом и нигде не сохраняется.
          </div>
          <input placeholder="Логин (без @tpu.ru)" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} />
          <input
            type="password"
            placeholder="Пароль"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            disabled={busy || !login || !password}
            onClick={() =>
              run(async () => {
                await api.loginLdap(login, password);
                props.onLoggedIn();
              }, 'Неверный логин или пароль.')
            }
          >
            Войти
          </button>
        </>
      )}

      {mode === 'email' && (
        <>
          <div className="sub" style={{ color: 'var(--muted)' }}>
            Введите корпоративную почту{domains.length ? ` (${domains.map((d) => '@' + d).join(', ')})` : ''} — пришлём код.
          </div>
          <input
            type="email"
            placeholder="login@tpu.ru"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={codeSent}
          />
          {!codeSent ? (
            <button
              disabled={busy || !email}
              onClick={() =>
                run(async () => {
                  await api.requestEmailCode(email);
                  setCodeSent(true);
                }, 'Не удалось отправить код. Проверьте адрес.')
              }
            >
              Получить код
            </button>
          ) : (
            <>
              <input inputMode="numeric" placeholder="Код из письма" value={code} onChange={(e) => setCode(e.target.value)} />
              <button
                disabled={busy || code.length < 4}
                onClick={() =>
                  run(async () => {
                    await api.verifyEmailCode(email, code);
                    props.onLoggedIn();
                  }, 'Неверный или просроченный код.')
                }
              >
                Войти
              </button>
            </>
          )}
        </>
      )}

      {(mode === 'guest' || mode === 'student') && (
        <>
          <div className="sub" style={{ color: 'var(--muted)' }}>
            {mode === 'guest'
              ? 'Гостю доступны публичные темы: поступление, контакты, адреса, режим работы, заселение.'
              : 'Полный доступ ко всем темам поддержки. В демо-режиме личность не проверяется — на проде здесь вход по учётной записи ТПУ.'}
          </div>
          <input placeholder="Ваше имя" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.loginDev(name || (mode === 'guest' ? 'Гость' : 'Студент'), props.tenant, mode === 'guest' ? 'guest' : 'full');
                props.onLoggedIn();
              }, 'Вход отключён на сервере.')
            }
          >
            Войти
          </button>
        </>
      )}

      {mode !== 'menu' && enabledCount > 1 && (
        <button
          className="btn-secondary"
          onClick={() => {
            setMode('menu');
            setError(null);
          }}
        >
          Другой способ входа
        </button>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
