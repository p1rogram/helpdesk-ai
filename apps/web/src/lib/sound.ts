/**
 * AI: Sounds are opt-in per device and never touch the server. Two channels, each with its own
 * switch in the profile: short effects on taps (buttons, quick replies, send) and background
 * music. Files live in /public/sounds; a missing file fails silently - the app never breaks
 * because of audio. Browsers allow playback only after a user gesture, so both channels start
 * from a click: the effect itself is a click, the music is (re)started by the profile switch or
 * by the first tap after loading.
 */
export interface SoundSettings {
  sfx: boolean;
  music: boolean;
}

const KEY = 'helpdesk.sound';
/** AI: First source that exists wins: the team's mp3, otherwise the bundled wav placeholder. */
const SFX_SOURCES = ['/sounds/click.mp3', '/sounds/click.wav'];
const MUSIC_SOURCES = ['/sounds/bg.mp3', '/sounds/bg.ogg'];
const MUSIC_VOLUME = 0.2;

export function getSoundSettings(): SoundSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { sfx: false, music: false, ...(JSON.parse(raw) as Partial<SoundSettings>) };
  } catch {
    /* private mode or blocked storage - defaults below */
  }
  return { sfx: false, music: false };
}

export function setSoundSettings(s: SoundSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
  applySoundSettings(s);
}

let sfx: HTMLAudioElement | null = null;
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

function musicElement(): HTMLAudioElement {
  if (!music) {
    music = audioWithSources(MUSIC_SOURCES);
    music.loop = true;
    music.volume = MUSIC_VOLUME;
  }
  return music;
}

/** AI: Short tap sound; overlapping taps restart it instead of queueing. */
export function playTap(): void {
  if (!current.sfx) return;
  try {
    const a = sfxElement();
    a.currentTime = 0;
    void a.play().catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/** AI: Music is started here (needs a gesture); pause happens immediately on switch-off. */
export function applySoundSettings(s: SoundSettings): void {
  current = s;
  if (s.sfx) sfxElement().load();
  if (s.music) {
    void musicElement()
      .play()
      .catch(() => undefined);
  } else if (music) {
    music.pause();
  }
}

/**
 * AI: One listener for the whole app: every real button tap makes the sound, and the same tap
 * is the user gesture that lets background music start after a page load.
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
