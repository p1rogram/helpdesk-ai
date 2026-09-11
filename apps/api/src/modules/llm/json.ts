/**
 * AI: Терпимое извлечение JSON из вывода модели. Понимает: голый JSON, ограждения ```json, текст до
 * или после объекта. Возвращает `undefined`, если ничего разобрать не удалось (вызывающий код
 * проверяет через Zod).
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    const inner = tryParse(fence[1].trim());
    if (inner !== undefined) return inner;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return tryParse(trimmed.slice(start, end + 1));
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
