import { useMemo } from 'react';
import type { ChatMessage } from '@helpdesk/shared';
import { renderMarkdown } from '../lib/markdown';
import { Icon } from './Icon';
import { StepList, parseSteps } from './StepList';

/**
 * AI: Кто смотрит на чат: конечный пользователь (помощник слева) или оператор (пользователь слева).
 */
export type Perspective = 'user' | 'operator';

type Props = { perspective?: Perspective } & (
  | { message: ChatMessage; streaming?: false; status?: undefined }
  | { message?: undefined; streaming: true; content: string; status?: string }
);

export function MessageBubble(props: Props) {
  const role = props.streaming ? 'assistant' : props.message.role;
  const content = props.streaming ? props.content : props.message.content;
  const author = props.streaming ? undefined : props.message.author;
  const perspective = props.perspective ?? 'user';

  // AI: Сторона раскладки: «моё» идёт вправо. Для оператора всё, что отправлено пользователю, -
  // «моё».
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

  // AI: Пошаговые ответы становятся интерактивным чек-листом; всё остальное - markdown.
  const parsed = useMemo(
    () => (role === 'assistant' && content ? parseSteps(content) : null),
    [role, content],
  );
  const html = useMemo(
    () => (role === 'assistant' && content && !parsed ? renderMarkdown(content) : ''),
    [role, content, parsed],
  );
  const leadHtml = useMemo(() => (parsed?.lead ? renderMarkdown(parsed.lead) : ''), [parsed]);
  const tailHtml = useMemo(() => (parsed?.tail ? renderMarkdown(parsed.tail) : ''), [parsed]);

  const time = props.streaming
    ? ''
    : new Date(props.message.createdAt).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      });
  const showAvatar = side === 'assistant';

  return (
    <div
      className={`msg ${side}${role === 'assistant' && !author && perspective === 'operator' ? ' ai' : ''}`}
    >
      {label && <div className="author">{label}</div>}
      <div className="msg-row">
        {showAvatar && (
          <span className={`avatar${author ? ' op' : ''}`}>
            <Icon name={author ? 'user' : 'bot'} size={16} />
          </span>
        )}
        <div className="bubble">
          {role === 'assistant' ? (
            content ? (
              parsed ? (
                <>
                  {/* Очищено DOMPurify в renderMarkdown - выводу модели никогда не доверяем в сыром виде. */}
                  {leadHtml && <div dangerouslySetInnerHTML={{ __html: leadHtml }} />}
                  <StepList steps={parsed.steps} />
                  {tailHtml && (
                    <div style={{ marginTop: 8 }} dangerouslySetInnerHTML={{ __html: tailHtml }} />
                  )}
                </>
              ) : (
                <div dangerouslySetInnerHTML={{ __html: html }} />
              )
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
      </div>
      {time && <div className="time">{time}</div>}
    </div>
  );
}
