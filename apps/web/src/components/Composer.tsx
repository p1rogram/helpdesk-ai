import { useRef, useState } from 'react';

export function Composer(props: { disabled: boolean; placeholder: string; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const t = text.trim();
    if (!t || props.disabled) return;
    props.onSend(t);
    setText('');
    ref.current?.focus();
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={1}
        maxLength={2000}
        value={text}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button disabled={props.disabled || !text.trim()} onClick={submit}>
        ➤
      </button>
    </div>
  );
}
