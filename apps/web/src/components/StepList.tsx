/** AI: Numbered instructions from the knowledge base, shown as a plain ordered list. */
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
 * AI: Splits an assistant message into (lead text, numbered steps, tail text). Returns `null` when the
 * message is not a step-by-step instruction, so it can be rendered as ordinary markdown instead.
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
      // A numbered line continues the list only if it follows the expected order.
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

/** AI: Removes the light markdown the model uses inside a step (bold / inline code). */
function stripMd(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1').trim();
}
