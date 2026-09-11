import { Icon, categoryVisual } from './Icon';

/** AI: Category pill with the system's confidence, as in the design: "Сеть и Wi-Fi · 92%". */
export function CategoryBadge({
  categoryId,
  name,
  confidence,
}: {
  categoryId: string | null;
  name: string;
  confidence: number | null;
}) {
  const { icon } = categoryVisual(categoryId);
  return (
    <span className="cat-badge">
      <span className="ico">
        <Icon name={icon} size={14} />
      </span>
      {name}
      {confidence !== null && <span className="conf">{Math.round(confidence * 100)}%</span>}
    </span>
  );
}
