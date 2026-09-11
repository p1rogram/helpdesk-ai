#!/usr/bin/env node
/**
 * help.tpu.ru knowledge-base collector (Naumen Service Desk portal, login required).
 *
 * A real Chrome window opens; log in with your TPU account, then press Enter in the terminal.
 * The script then reads every knowledge-base article (title, tags, body text, links) and the
 * full service catalog, and writes them to JSON. Read-only: it never submits anything.
 *
 * Setup (once):   npm i -D playwright && npx playwright install chromium
 * Run:            node scripts/crawl-help-tpu.mjs --out data/raw/help-tpu.json
 *
 * Output: { "collectedAt", "services":[{name, description}], "articles":[{id,url,title,services,categories,body,links}] }
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';

const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'data/raw/help-tpu.json';
const BASE = 'https://help.tpu.ru/portal/';
mkdirSync(dirname(out), { recursive: true });

const ask = (q) =>
  new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => (rl.close(), res(a)));
  });

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE);
await ask('\nВойдите в help.tpu.ru в открывшемся окне, затем нажмите Enter здесь... ');

// ---------- services catalog ----------
await page.goto(BASE + 'navigator-services.html?activeTab=2', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);
for (let i = 0; i < 40; i++) {
  const more = page.getByText('Показать еще', { exact: true }).first();
  if (!(await more.isVisible().catch(() => false))) break;
  await more.click();
  await page.waitForTimeout(800);
}
const services = await page.evaluate(() => {
  // Each service card: name element followed by an optional description.
  const items = [];
  document.querySelectorAll('a[href*="navigator-service-call"], a[href*="navigator-fields"]').forEach((a) => {
    const name = a.textContent.trim().replace(/\s+/g, ' ');
    const desc = a.parentElement?.nextElementSibling?.textContent?.trim().replace(/\s+/g, ' ') ?? '';
    if (name) items.push({ name, description: desc.slice(0, 500), href: a.getAttribute('href') });
  });
  return items;
});
console.log(`services: ${services.length}`);

// ---------- article list ----------
await page.goto(BASE + 'articles.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);
const allTab = page.getByText('Все', { exact: true }).first();
if (await allTab.isVisible().catch(() => false)) await allTab.click();
await page.waitForTimeout(1500);
for (let i = 0; i < 100; i++) {
  const more = page.getByText('Показать еще', { exact: true }).first();
  if (!(await more.isVisible().catch(() => false))) break;
  await more.click();
  await page.waitForTimeout(1000);
}
const ids = await page.evaluate(() => {
  const set = new Set();
  document.querySelectorAll('a[href*="kb="]').forEach((a) => {
    const m = /kb=KB\$(\d+)/.exec(a.getAttribute('href') ?? '');
    if (m) set.add(m[1]);
  });
  return [...set];
});
console.log(`articles: ${ids.length}`);

// ---------- each article ----------
const articles = [];
for (const [i, id] of ids.entries()) {
  const url = `${BASE}article.html?kb=KB$${id}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.waitForTimeout(1200);
  const data = await page.evaluate(() => {
    const lines = document.body.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
    const frame = document.querySelector('iframe');
    let body = '';
    let links = [];
    try {
      body = frame?.contentDocument?.body?.innerText ?? '';
      links = [...(frame?.contentDocument?.querySelectorAll('a[href]') ?? [])]
        .map((a) => ({ text: a.textContent.trim().slice(0, 80), href: a.href }))
        .filter((l) => l.href && !/summernote/.test(l.href));
    } catch {
      /* cross-origin */
    }
    return { title: lines[2] ?? '', services: lines[3] ?? '', categories: lines[4] ?? '', body: body.trim(), links };
  });
  articles.push({ id, url, ...data });
  console.log(`[${i + 1}/${ids.length}] ${data.title} (${data.body.length} chars)`);
}

writeFileSync(out, JSON.stringify({ collectedAt: new Date().toISOString(), services, articles }, null, 2), 'utf8');
console.log(`saved -> ${out}`);
await browser.close();
