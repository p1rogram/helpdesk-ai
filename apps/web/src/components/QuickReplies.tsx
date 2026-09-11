import type { QuickReply } from '@helpdesk/shared';

/** AI: Highlight the affirmative action, mute the "no" one - as in the design. */
function toneOf(value: string): string {
  if (value === '__helped') return 'primary';
  if (value === '__dismiss' || value === '__notHelped' || value === '__not_helped') return 'ghost';
  return '';
}

export function QuickReplies(props: { items: QuickReply[]; onPick: (q: QuickReply) => void }) {
  if (!props.items.length) return null;
  return (
    <div className={`quick${props.items.length > 4 ? ' grid' : ''}`}>
      {props.items.map((q) => (
        <button key={q.value} className={toneOf(q.value)} onClick={() => props.onPick(q)}>
          {q.label}
        </button>
      ))}
    </div>
  );
}
