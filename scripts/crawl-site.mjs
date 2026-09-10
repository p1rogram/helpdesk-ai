#!/usr/bin/env node
/**
 * Public site crawler (no login). Walks tpu.ru (or any site) inside allowed URL prefixes and
 * stores clean page text as JSONL - the raw material for knowledge-base articles / RAG.
 *
 * Usage:
 *   node scripts/crawl-site.mjs --start https://tpu.ru/student --allow https://tpu.ru/student \
 *        --allow https://tpu.ru/university --max 300 --out data/raw/tpu-site.jsonl
 *
 * Options:
 *   --start <url>     seed URL (repeatable)
 *   --allow <prefix>  only follow links starting with this prefix (repeatable; default = seeds' origins)
 *   --max <n>         max pages (default 200)
 *   --delay <ms>      pause between requests (default 400 - be polite)
 *   --out <file>      JSONL output (default data/raw/site.jsonl)
 *
 * Output line: {"url","title","h1","text","headings":[...],"links":[...],"fetchedAt"}
 * Re-running appends only new URLs (already crawled ones are skipped).
 */
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as cheerio from 'cheerio';

const args = process.argv.slice(2);
const opt = { start: [], allow: [], max: 200, delay: 400, out: 'data/raw/site.jsonl' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = args[i + 1];
  if (a === '--start') opt.start.push(v), i++;
  else if (a === '--allow') opt.allow.push(v), i++;
  else if (a === '--max') opt.max = Number(v), i++;
  else if (a === '--delay') opt.delay = Number(v), i++;
  else if (a === '--out') opt.out = v, i++;
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
      /* ignore */
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
    // drop tracking params
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|yclid|fbclid|_ga)/.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
};
const allowed = (u) => opt.allow.some((p) => u.startsWith(p));

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
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; helpdesk-kb-crawler/1.0; +for internal knowledge base)' },
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
  $('script, style, noscript, iframe, svg, nav, header, footer, form, .cookie, .breadcrumbs, [role=navigation]').remove();
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
    JSON.stringify({ url, title, h1, text, headings, links: [...new Set(links)].slice(0, 200), fetchedAt: new Date().toISOString() }) + '\n',
  );
  done++;
  console.log(`[${done}/${opt.max}] ${url} (${text.length} chars, queue ${queue.length})`);
  await sleep(opt.delay);
}
console.log(`done: ${done} new pages -> ${opt.out}`);
