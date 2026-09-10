import { useEffect, useState } from 'react';
import type { ApiClient } from '../lib/api';
import type { PlatformAdapter } from '../lib/platform';

/**
 * Shown only outside a messenger (plain browser demo). Inside Telegram the login is silent.
 * Tenant selector = "switch the sphere" demo: same code, different catalog.
 */
export function LoginScreen(props: {
  api: ApiClient;
  platform: PlatformAdapter;
  error: string | null;
  onLoggedIn: () => void;
}) {
  const [name, setName] = useState('');
  const [tenants, setTenants] = useState<Array<{ id: string; sphere: string }>>([]);
  const [tenant, setTenant] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(props.error);

  useEffect(() => {
    props.api
      .tenants()
      .then((r) => {
        setTenants(r.tenants);
        setTenant(r.default);
      })
      .catch(() => {});
  }, [props.api]);

  if (props.platform.kind === 'telegram') {
    return <div className="login">{props.error ? <div className="error">{props.error}</div> : <div className="empty">Подключение…</div>}</div>;
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.api.loginDev(name || 'Гость', tenant || undefined);
      props.onLoggedIn();
    } catch {
      setError('Гостевой вход отключён на сервере (AUTH_DEV_BYPASS=false). Откройте приложение из Telegram.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <h2 style={{ margin: 0 }}>Помощник поддержки</h2>
      <div className="sub" style={{ color: 'var(--muted)' }}>
        Демо-вход для браузера. В Telegram вход выполняется автоматически.
      </div>
      <input placeholder="Ваше имя" value={name} onChange={(e) => setName(e.target.value)} />
      {tenants.length > 1 && (
        <select value={tenant} onChange={(e) => setTenant(e.target.value)}>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.sphere}
            </option>
          ))}
        </select>
      )}
      <button disabled={busy} onClick={submit}>
        Войти
      </button>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
