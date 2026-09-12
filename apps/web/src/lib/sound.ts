/**
 * AI: Звуки включаются по желанию на устройстве и не касаются сервера. Два канала, у каждого свой
 * переключатель в профиле: звуки окружения (нажатия кнопок, отправка и получение сообщений) и
 * фоновая музыка. Файлы лежат в /public/sounds; отсутствующий файл тихо игнорируется - приложение никогда
 * не ломается из-за аудио. Браузеры разрешают воспроизведение только после жеста пользователя,
 * поэтому оба канала стартуют от клика: эффект сам по себе клик, музыка (пере)запускается
 * переключателем в профиле или первым нажатием после загрузки.
 */
export interface SoundSettings {
  sfx: boolean;
  music: boolean;
}

const KEY = 'helpdesk.sound';
/** AI: Побеждает первый существующий источник: mp3 команды, иначе встроенная wav-заглушка. */
const SFX_SOURCES = ['/sounds/click.mp3', '/sounds/click.wav'];
/** AI: Отправка и получение сообщения - два разных звука. */
const SEND_SOURCES = ['/sounds/send.mp3', '/sounds/click.wav'];
const RECEIVE_SOURCES = ['/sounds/receive.mp3', '/sounds/click.wav'];
const MUSIC_SOURCES = ['/sounds/bg.mp3', '/sounds/bg.ogg'];
const MUSIC_VOLUME = 0.2;

export function getSoundSettings(): SoundSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { sfx: true, music: false, ...(JSON.parse(raw) as Partial<SoundSettings>) };
  } catch {
    /* приватный режим или заблокированное хранилище - значения по умолчанию ниже */
  }
  // AI: Отклик на нажатия включён по умолчанию, музыка - по желанию.
  return { sfx: true, music: false };
}

export function setSoundSettings(s: SoundSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* игнорируем */
  }
  applySoundSettings(s);
}

let sfx: HTMLAudioElement | null = null;
let sendEl: HTMLAudioElement | null = null;
let receiveEl: HTMLAudioElement | null = null;
let music: HTMLAudioElement | null = null;
let current: SoundSettings = { sfx: false, music: false };

function audioWithSources(urls: string[]): HTMLAudioElement {
  const a = document.createElement('audio');
  for (const url of urls) {
    const src = document.createElement('source');
    src.src = url;
    a.appendChild(src);
  }
  a.preload = 'auto';
  return a;
}

function sfxElement(): HTMLAudioElement {
  if (!sfx) {
    sfx = audioWithSources(SFX_SOURCES);
    sfx.volume = 0.6;
  }
  return sfx;
}

function sendElement(): HTMLAudioElement {
  if (!sendEl) {
    sendEl = audioWithSources(SEND_SOURCES);
    sendEl.volume = 0.7;
  }
  return sendEl;
}

function receiveElement(): HTMLAudioElement {
  if (!receiveEl) {
    receiveEl = audioWithSources(RECEIVE_SOURCES);
    receiveEl.volume = 0.7;
  }
  return receiveEl;
}

function musicElement(): HTMLAudioElement {
  if (!music) {
    music = audioWithSources(MUSIC_SOURCES);
    music.loop = true;
    music.volume = MUSIC_VOLUME;
  }
  return music;
}

/** AI: Короткий звук нажатия; наложившиеся нажатия перезапускают его, а не ставят в очередь. */
export function playTap(): void {
  if (!current.sfx) return;
  try {
    const a = sfxElement();
    a.currentTime = 0;
    void a.play().catch(() => undefined);
  } catch {
    /* игнорируем */
  }
}

function play(a: HTMLAudioElement): void {
  try {
    a.currentTime = 0;
    void a.play().catch(() => undefined);
  } catch {
    /* игнорируем */
  }
}

/** AI: Своё сообщение отправлено. */
export function playSend(): void {
  if (current.sfx) play(sendElement());
}

/** AI: Пришёл ответ - помощника или специалиста. */
export function playReceive(): void {
  if (current.sfx) play(receiveElement());
}

/** AI: Музыка запускается здесь (нужен жест); пауза происходит сразу при выключении. */
export function applySoundSettings(s: SoundSettings): void {
  current = s;
  if (s.sfx) {
    sfxElement().load();
    sendElement().load();
    receiveElement().load();
  }
  if (s.music) {
    void musicElement()
      .play()
      .catch(() => undefined);
  } else if (music) {
    music.pause();
  }
}

/**
 * AI: Один слушатель на всё приложение: каждое настоящее нажатие кнопки даёт звук, и то же нажатие
 * - жест пользователя, который позволяет фоновой музыке стартовать после загрузки страницы.
 */
export function installSoundHooks(): () => void {
  applySoundSettings(getSoundSettings());
  const onClick = (e: MouseEvent) => {
    const el = e.target as HTMLElement | null;
    if (!el?.closest('button, [role="button"], a.btn')) return;
    playTap();
    if (current.music && music?.paused) void music.play().catch(() => undefined);
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
