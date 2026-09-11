import type { ReactNode } from 'react';

export type IconName =
  | 'chat'
  | 'history'
  | 'book'
  | 'user'
  | 'shield'
  | 'send'
  | 'sun'
  | 'moon'
  | 'auto'
  | 'search'
  | 'back'
  | 'check'
  | 'bot'
  | 'wifi'
  | 'key'
  | 'mail'
  | 'monitor'
  | 'building'
  | 'badge'
  | 'graduation'
  | 'library'
  | 'info';

/** AI: Single-path/stroke icon set (currentColor), so icons inherit the surrounding text colour. */
const PATHS: Record<IconName, ReactNode> = {
  chat: <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.9-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />,
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v14H6.5A2.5 2.5 0 0 0 4 19.5Z" />
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20v4H6.5A2.5 2.5 0 0 1 4 19.5Z" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  shield: <path d="M12 3l7 3v5.5c0 4.3-2.9 8.2-7 9.5-4.1-1.3-7-5.2-7-9.5V6l7-3Z" />,
  send: <path d="M4 12l16-8-5 8 5 8-16-8Z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  auto: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor" stroke="none" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  check: <path d="M4.5 12.5l5 5 10-11" />,
  bot: (
    <>
      <rect x="4" y="7.5" width="16" height="12" rx="3.5" />
      <path d="M12 3.5v4M9 13h.01M15 13h.01" />
    </>
  ),
  wifi: (
    <>
      <path d="M2.5 8.5a15 15 0 0 1 19 0M6 12.2a10 10 0 0 1 12 0M9.5 15.8a5 5 0 0 1 5 0" />
      <path d="M12 19.5h.01" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M18 12v3.5M15.5 12v2.5" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M3.8 7l8.2 6 8.2-6" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="2.5" />
      <path d="M9 20h6M12 16.5V20" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V6l8-3 8 3v15" />
      <path d="M9.5 21v-4.5h5V21M8 9.5h.01M12 9.5h.01M16 9.5h.01M8 13h.01M12 13h.01M16 13h.01" />
    </>
  ),
  badge: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <circle cx="12" cy="10" r="2.4" />
      <path d="M8 17a4 4 0 0 1 8 0" />
    </>
  ),
  graduation: (
    <>
      <path d="M12 4l9 4.5-9 4.5-9-4.5L12 4Z" />
      <path d="M6.5 11v4.5c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V11" />
    </>
  ),
  library: (
    <>
      <path d="M5 4.5h4V20H5zM10.5 4.5h4V20h-4z" />
      <path d="M16.5 6l3.2 13.2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8h.01" />
    </>
  ),
};

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

/** AI: Maps a catalog category id to an icon + accent colour class for tiles and cards. */
export function categoryVisual(categoryId: string | null): { icon: IconName; tone: string } {
  const map: Record<string, { icon: IconName; tone: string }> = {
    account: { icon: 'key', tone: 'violet' },
    lms: { icon: 'graduation', tone: 'green' },
    portal: { icon: 'monitor', tone: 'blue' },
    study: { icon: 'graduation', tone: 'amber' },
    network: { icon: 'wifi', tone: 'blue' },
    email: { icon: 'mail', tone: 'amber' },
    it: { icon: 'monitor', tone: 'violet' },
    campus: { icon: 'building', tone: 'green' },
    access: { icon: 'badge', tone: 'amber' },
    library: { icon: 'library', tone: 'violet' },
    general: { icon: 'info', tone: 'blue' },
  };
  return map[categoryId ?? ''] ?? { icon: 'info', tone: 'blue' };
}
