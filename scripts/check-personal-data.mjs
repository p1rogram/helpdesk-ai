/**
 * AI: Гейт персональных данных для корпуса знаний. Проверяет всё, что попадает в образ
 * (data/catalog, data/raw), теми же правилами, что API применяет при индексации, и падает, если
 * найдено имя или мобильный номер - свежий краул не может попасть в релиз неочищенным.
 *
 *   npm run build -w @helpdesk/api && node scripts/check-personal-data.mjs   # проверка
 *   node scripts/check-personal-data.mjs --fix                              # очистить на месте
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPersonalData, redactNames } from '../apps/api/dist/modules/rag/redact.js';

const fix = process.argv.includes('--fix');
const roots = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = [];
const walk = (p) => {
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
  else if (/\.(json|jsonl|md|txt)$/.test(p)) files.push(p);
};
(roots.length ? roots : ['data/catalog', 'data/raw']).forEach(walk);

/** AI: Чистит каждое строковое значение JSON-документа, какой бы формы он ни был. */
const deep = (v) => {
  if (typeof v === 'string') return redactNames(v);
  if (Array.isArray(v)) return v.map(deep);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
  return v;
};

let problems = 0;
for (const f of files) {
  let text = readFileSync(f, 'utf8');
  if (fix) {
    if (f.endsWith('.jsonl')) {
      text = text
        .split('\n')
        .map((l) => (l.trim() ? JSON.stringify(deep(JSON.parse(l))) : l))
        .join('\n');
    } else if (f.endsWith('.json')) {
      text = JSON.stringify(deep(JSON.parse(text)), null, 2) + '\n';
    } else {
      text = redactNames(text);
    }
    writeFileSync(f, text);
  }
  const found = findPersonalData(text);
  if (found.length) {
    problems += found.length;
    console.error(
      `${f}: ${found.length} fragment(s), e.g. ${[...new Set(found)].slice(0, 4).join('; ')}`,
    );
  }
}
if (problems) {
  console.error(
    `\nFound ${problems} personal-data fragment(s) in ${files.length} files. Run with --fix or clean by hand.`,
  );
  process.exit(1);
}
console.log(`ok: ${files.length} files, no personal data`);
