import { useMemo } from 'react';
import type { ChatMessage } from '@helpdesk/shared';
import { renderMarkdown } from '../lib/markdown';

/** Who is looking at the chat: the end user (assistant on the left) or an operator (user on the left). */
export type Perspective = 'user' | 'operator';

type Props = { perspective?: Perspective } & (
  | { message: ChatMessage; streaming?: false; status?: undefined }
  | { message?: undefined; streaming: true; content: string; status?: string }
);

export function MessageBubble(props: Props) {
  const role = props.streaming ? 'assistant' : props.message.role;
  const content = props.streaming ? props.content : props.message.content;
  const html = useMemo(() => (role === 'assistant' ? renderMarkdown(content) : ''), [role, content]);
  const time = props.streaming ? '' : new Date(props.message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const author = props.streaming ? undefined : props.message.author;
  const perspective = props.perspective ?? 'user';
  // Layout side: "mine" messages go right. For the operator, everything sent to the user is "mine".
  const side = perspective === 'operator' ? (role === 'user' ? 'assistant' : 'user') : role;
  const label =
    perspective === 'operator'
      ? role === 'user'
        ? 'Пользователь'
        : author
          ? `Оператор · ${author}`
          : 'Помощник (ИИ)'
      : author
        ? `Специалист · ${author}`
        : undefined;
  return (
    <div className={`msg ${side}${role === 'assistant' && !author && perspective === 'operator' ? ' ai' : ''}`}>
      {label && <div className="author">{label}</div>}
      <div className="bubble">
        {role === 'assistant' ? (
          content ? (
            // Sanitised by DOMPurify in renderMarkdown - model output is never trusted raw.
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <span className="typing">
              <i />
              <i />
              <i />
              {props.streaming && props.status && <span className="status">{props.status}</span>}
            </span>
          )
        ) : (
          <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>
        )}
      </div>
      {time && <div className="time">{time}</div>}
    </div>
  );
}
