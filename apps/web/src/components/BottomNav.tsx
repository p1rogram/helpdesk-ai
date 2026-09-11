import { Icon, type IconName } from './Icon';

export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
}

/** AI: Мобильная панель вкладок (Telegram Mini App и сайт используют одну и ту же). */
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
        <button
          key={it.key}
          className={active === it.key ? 'active' : ''}
          onClick={() => onSelect(it.key)}
        >
          <Icon name={it.icon} size={21} />
          {it.label}
        </button>
      ))}
    </nav>
  );
}
