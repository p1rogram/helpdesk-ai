import type { QuickReply } from '@helpdesk/shared';

export function QuickReplies(props: { items: QuickReply[]; onPick: (q: QuickReply) => void }) {
  if (!props.items.length) return null;
  return (
    <div className={`quick${props.items.length > 4 ? ' grid' : ''}`}>
      {props.items.map((q) => (
        <button key={q.value} onClick={() => props.onPick(q)}>
          {q.label}
        </button>
      ))}
    </div>
  );
}
