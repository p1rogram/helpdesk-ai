import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

const MAX_HEIGHT = 132;

/**
 * AI: Поле сообщения растёт вместе с текстом до предела, затем прокручивается внутри себя (обычное
 * поведение мессенджера). Когда тикет закрыт, поле - одна строка без прокрутки: отключённое
 * многострочное поле с полосой прокрутки выглядит сломанным.
 */
export function Composer(props: {
  disabled: boolean;
  placeholder: string;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (props.disabled) {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text, props.disabled]);

  const submit = () => {
    const t = text.trim();
    if (!t || props.disabled) return;
    props.onSend(t);
    setText('');
    ref.current?.focus();
  };

  return (
    <div className={`composer${props.disabled ? ' locked' : ''}`}>
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
      <button disabled={props.disabled || !text.trim()} onClick={submit} aria-label="Отправить">
        <Icon name="send" size={18} />
      </button>
    </div>
  );
}
