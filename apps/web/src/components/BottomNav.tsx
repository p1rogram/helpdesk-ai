import { Icon, type IconName } from './Icon';

export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
}

/** AI: Mobile-first tab bar (Telegram Mini App and the website use the same one). */
export function BottomNav({
  items,
  active,
  onSelect,
}: {
  items: NavItem[];
  active: string;
  onSelect: (key: string) => void;
}) {
  return (
    <nav className="bottomnav">
      {items.map((it) => (
        <button key={it.key} className={active === it.key ? 'active' : ''} onClick={() => onSelect(it.key)}>
          <Icon name={it.icon} size={21} />
          {it.label}
        </button>
      ))}
    </nav>
  );
}
