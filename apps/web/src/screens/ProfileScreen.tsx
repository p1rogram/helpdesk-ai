import { useState } from 'react';
import { Icon } from '../components/Icon';
import { getSoundSettings, setSoundSettings, type SoundSettings } from '../lib/sound';
import type { PlatformAdapter } from '../lib/platform';
import type { ThemeMode } from '../lib/theme';

const PLATFORM_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  vk: 'VK',
  max: 'MAX',
  web: 'Браузер',
  corp: 'Учётная запись организации',
};

/** AI: Profile tab: who you are, appearance (light / dark / auto) and what the assistant can do. */
export function ProfileScreen(props: {
  platform: PlatformAdapter;
  displayName: string;
  sphere: string;
  isAdmin: boolean;
  scope: 'guest' | 'full';
  theme: ThemeMode;
  onTheme: (m: ThemeMode) => void;
  onLogout?: () => void;
}) {
  const [sound, setSound] = useState<SoundSettings>(getSoundSettings);
  const toggle = (key: keyof SoundSettings) => {
    const next = { ...sound, [key]: !sound[key] };
    setSound(next);
    setSoundSettings(next);
  };
  return (
    <div className="profile">
      <div className="panel">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="tile-ico" style={{ width: 46, height: 46, borderRadius: 14 }}>
            <Icon name="user" size={22} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{props.displayName || 'Гость'}</div>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>
              {props.scope === 'guest'
                ? 'Гость'
                : (PLATFORM_LABEL[props.platform.kind] ?? props.platform.kind)}
              {props.isAdmin ? ' · оператор' : ''}
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>Оформление</h3>
        <div className="seg">
          <button
            className={props.theme === 'light' ? 'active' : ''}
            onClick={() => props.onTheme('light')}
          >
            <Icon name="sun" size={16} /> Светлая
          </button>
          <button
            className={props.theme === 'dark' ? 'active' : ''}
            onClick={() => props.onTheme('dark')}
          >
            <Icon name="moon" size={16} /> Тёмная
          </button>
          <button
            className={props.theme === 'auto' ? 'active' : ''}
            onClick={() => props.onTheme('auto')}
          >
            <Icon name="auto" size={16} /> Авто
          </button>
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 8 }}>
          «Авто» подстраивается под оформление{' '}
          {props.platform.kind === 'telegram' ? 'Telegram' : 'системы'}.
        </div>
      </div>

      <div className="panel">
        <h3>Звук</h3>
        <label className="switch-row">
          <span>
            Звуки нажатий
            <span className="hint">Короткий отклик на кнопки и отправку</span>
          </span>
          <input type="checkbox" checked={sound.sfx} onChange={() => toggle('sfx')} />
          <span className="switch" aria-hidden="true" />
        </label>
        <label className="switch-row">
          <span>
            Фоновая музыка
            <span className="hint">Тихо, на повторе; выключается здесь же</span>
          </span>
          <input type="checkbox" checked={sound.music} onChange={() => toggle('music')} />
          <span className="switch" aria-hidden="true" />
        </label>
      </div>

      {props.scope === 'guest' && (
        <div className="panel">
          <h3>Гостевой доступ</h3>
          <div style={{ color: 'var(--muted)', fontSize: 13.5 }}>
            Доступны только публичные темы: поступление, контакты, адреса, режим работы, заселение.
            Войдите с учётной записью ТПУ, чтобы получить помощь по учёбе, доступам, сервисам и
            оборудованию.
          </div>
        </div>
      )}

      <div className="panel">
        <h3>Сфера поддержки</h3>
        <div className="row">
          <span className="k">Организация</span>
          <span style={{ textAlign: 'right' }}>{props.sphere || '-'}</span>
        </div>
        <div className="row">
          <span className="k">Помощник умеет</span>
          <span style={{ textAlign: 'right' }}>
            определять категорию, задавать уточнения, давать пошаговое решение
          </span>
        </div>
        <div className="row">
          <span className="k">Специалист</span>
          <span style={{ textAlign: 'right' }}>подключается только с вашего согласия</span>
        </div>
      </div>

      {props.onLogout && (
        <button className="btn secondary" onClick={props.onLogout}>
          Выйти
        </button>
      )}
    </div>
  );
}
