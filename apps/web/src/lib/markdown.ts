import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

/**
 * AI: Текст помощника - вывод модели -> считается недоверенным. Отрендеренный markdown очищается
 * (без скриптов, без обработчиков событий, ссылки только с безопасными протоколами).
 */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'ol',
      'ul',
      'li',
      'strong',
      'em',
      'b',
      'i',
      'code',
      'pre',
      'a',
      'h3',
      'h4',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:)/i,
  });
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
