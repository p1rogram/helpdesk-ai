/** AI: Нумерованная инструкция из базы знаний, показанная простым упорядоченным списком. */
export function StepList({ steps }: { steps: string[] }) {
  return (
    <ol className="steplist">
      {steps.map((s, i) => (
        <li key={i}>
          <span className="step-n">{i + 1}</span>
          <span className="step-text">{s}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * AI: Делит сообщение помощника на (вступление, нумерованные шаги, хвост). Возвращает `null`, если
 * сообщение не является пошаговой инструкцией, - тогда оно рендерится как обычный markdown.
 */
export function parseSteps(text: string): { lead: string; steps: string[]; tail: string } | null {
  const lines = text.split('\n');
  const lead: string[] = [];
  const steps: string[] = [];
  const tail: string[] = [];
  let phase: 'lead' | 'steps' | 'tail' = 'lead';

  for (const raw of lines) {
    const line = raw.trim();
    const m = /^(\d{1,2})[.)]\s+(.*)$/.exec(line);
    if (m && phase !== 'tail') {
      // AI: Нумерованная строка продолжает список, только если идёт в ожидаемом порядке.
      if (Number(m[1]) === steps.length + 1) {
        steps.push(stripMd(m[2] ?? ''));
        phase = 'steps';
        continue;
      }
    }
    if (phase === 'steps') {
      if (!line) continue;
      phase = 'tail';
      tail.push(line);
      continue;
    }
    (phase === 'lead' ? lead : tail).push(line);
  }

  if (steps.length < 2) return null;
  return { lead: lead.join('\n').trim(), steps, tail: tail.join('\n').trim() };
}

/** AI: Убирает лёгкий markdown, которым модель пользуется внутри шага (жирный / inline-код). */
function stripMd(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim();
}
