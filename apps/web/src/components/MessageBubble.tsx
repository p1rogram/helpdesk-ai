import { useMemo } from 'react';
import type { ChatMessage } from '@helpdesk/shared';
import { renderMarkdown } from '../lib/markdown';

type Props =
  | { message: ChatMessage; streaming?: false; status?: undefined }
  | { message?: undefined; streaming: true; content: string; status?: string };

export function MessageBubble(props: Props) {
  const role = props.streaming ? 'assistant' : props.message.role;
  const content = props.streaming ? props.content : props.message.content;
  const html = useMemo(() => (role === 'assistant' ? renderMarkdown(content) : ''), [role, content]);
  const time = props.streaming ? '' : new Date(props.message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`msg ${role}`}>
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
