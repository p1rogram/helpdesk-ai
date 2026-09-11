import { Icon, categoryVisual } from './Icon';

/** AI: Плашка категории с уверенностью системы, как в дизайне: «Сеть и Wi-Fi · 92%». */
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
