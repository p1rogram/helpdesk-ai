#!/usr/bin/env node
/**
 * Краулер публичного сайта (без входа). Обходит tpu.ru (или любой сайт) в пределах разрешённых
 * префиксов URL и сохраняет чистый текст страниц в JSONL - сырьё для статей базы знаний / RAG.
 *
 * Использование:
 *   node scripts/crawl-site.mjs --start https://tpu.ru/student --allow https://tpu.ru/student \
 *        --allow https://tpu.ru/university --max 300 --out data/raw/tpu-site.jsonl
 *
 * Параметры:
 *   --start <url>     стартовый URL (можно повторять)
 *   --allow <prefix>  оставаться внутри этого префикса URL, граница по пути (можно повторять;
 *                     по умолчанию = origin стартовых URL). "https://tpu.ru/student" разрешает
 *                     /student и /student/faq/, но не /students-club.
 *   --deny <prefix>   вырезать подраздел из разрешённой области (можно повторять)
 *   --max <n>         максимум страниц (по умолчанию 200)
 *   --delay <ms>      пауза между запросами (по умолчанию 400 - будьте вежливы)
 *   --out <file>      выходной JSONL (по умолчанию data/raw/site.jsonl)
 *
 * Строка вывода: {"url","title","h1","text","headings":[...],"links":[...],"fetchedAt"}
 * Повторный запуск дописывает только новые URL (уже скачанные пропускаются).
 */
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as cheerio from 'cheerio';

const args = process.argv.slice(2);
const opt = { start: [], allow: [], deny: [], max: 200, delay: 400, out: 'data/raw/site.jsonl' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = args[i + 1];
  if (a === '--start') {
    opt.start.push(v);
    i++;
  } else if (a === '--allow') {
    opt.allow.push(v);
    i++;
  } else if (a === '--deny') {
    opt.deny.push(v);
    i++;
  } else if (a === '--max') {
    opt.max = Number(v);
    i++;
  } else if (a === '--delay') {
    opt.delay = Number(v);
    i++;
  } else if (a === '--out') {
    opt.out = v;
    i++;
  }
}
if (!opt.start.length) {
  console.error('need at least one --start <url>');
  process.exit(1);
}
if (!opt.allow.length) opt.allow = opt.start.map((u) => new URL(u).origin);

mkdirSync(dirname(opt.out), { recursive: true });
const seen = new Set();
if (existsSync(opt.out)) {
  for (const line of readFileSync(opt.out, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      seen.add(JSON.parse(line).url);
    } catch {
      /* игнорируем */
    }
  }
  console.log(`resuming: ${seen.size} pages already in ${opt.out}`);
}

const SKIP_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|jpe?g|png|gif|svg|webp|mp4|mp3|ics)(\?|$)/i;
const normalize = (href, base) => {
  try {
    const u = new URL(href, base);
    u.hash = '';
    if (!/^https?:$/.test(u.protocol)) return null;
    if (SKIP_EXT.test(u.pathname)) return null;
    // AI: убираем параметры трекинга
    for (const k of [...u.searchParams.keys()])
      if (/^(utm_|yclid|fbclid|_ga)/.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
};
/**
 * Проверка области на ГРАНИЦЕ ПУТИ, чтобы `--allow https://tpu.ru/student` брал /student и
 * /student/faq/, но никогда /students-club. Завершающий слэш в префиксе необязателен. `--deny`
 * вырезает подразделы из разрешённой области (например --deny https://tpu.ru/student/news).
 */
const inScope = (u, prefixes) =>
  prefixes.some((raw) => {
    const p = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    return u === p || u.startsWith(p + '/') || u.startsWith(p + '?');
  });
// AI: Стартовые URL обходятся всегда, даже если разрешённый префикс записан с завершающим слэшем.
const allowed = (u) => (opt.start.includes(u) || inScope(u, opt.allow)) && !inScope(u, opt.deny);

const queue = [...opt.start];
let done = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

while (queue.length && done < opt.max) {
  const url = queue.shift();
  if (seen.has(url) || !allowed(url)) continue;
  seen.add(url);
  let html;
  try {
    const res = await fetch(url, {
      // AI: Минимальный набор заголовков: tpu.ru стоит за Qrator, который отвечает 503 на запросы,
      // имитирующие полный набор заголовков браузера, но им не являющиеся. Простые UA + Accept
      // проходят.
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) {
      console.log(`skip ${res.status} ${url}`);
      continue;
    }
    html = await res.text();
  } catch (e) {
    console.log(`error ${url}: ${e.message}`);
    continue;
  }

  const $ = cheerio.load(html);
  $(
    'script, style, noscript, iframe, svg, nav, header, footer, form, .cookie, .breadcrumbs, [role=navigation]',
  ).remove();
  const title = $('title').first().text().trim();
  const h1 = $('h1').first().text().trim();
  const root = $('main, article, .content, #content, .page-content').first();
  const scope = root.length ? root : $('body');
  const headings = scope
    .find('h2, h3')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  const text = scope
    .text()
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const links = [];
  $('a[href]').each((_, el) => {
    const n = normalize($(el).attr('href'), url);
    if (n) links.push(n);
    if (n && allowed(n) && !seen.has(n)) queue.push(n);
  });

  appendFileSync(
    opt.out,
    JSON.stringify({
      url,
      title,
      h1,
      text,
      headings,
      links: [...new Set(links)].slice(0, 200),
      fetchedAt: new Date().toISOString(),
    }) + '\n',
  );
  done++;
  console.log(`[${done}/${opt.max}] ${url} (${text.length} chars, queue ${queue.length})`);
  await sleep(opt.delay);
}
console.log(`done: ${done} new pages -> ${opt.out}`);
