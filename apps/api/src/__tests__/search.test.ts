import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogSchema } from '@helpdesk/shared';
import { KnowledgeIndex } from '../modules/knowledge/search.js';
import { REPO_ROOT } from '../config.js';

const catalog = CatalogSchema.parse(
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'data/catalog/tpu.json'), 'utf8')),
);
const index = new KnowledgeIndex(catalog.articles);

describe('KnowledgeIndex (TPU catalog)', () => {
  it.each([
    ['не могу подключиться к vpn из дома', 'network-vpn-not-connecting'],
    ['забыл пароль от учетной записи', 'account-change-password'],
    ['где посмотреть расписание пар', 'study-schedule'],
    ['потерял пропуск', 'access-lost-pass'],
    ['принтер myq не печатает', 'it-myq-print'],
    ['сколько попыток на задание в мудле', 'lms-attempts'],
    ['не работает розетка в общежитии', 'campus-repair'],
  ])('"%s" -> %s', (q, expected) => {
    const [top] = index.search(q, { limit: 1 });
    expect(top?.article.id).toBe(expected);
  });

  it('matches the last query token by prefix (autocomplete: "vp" -> vpn)', () => {
    const [top] = index.search('vp', { limit: 1 });
    expect(top?.article.id).toMatch(/vpn/);
    const [top2] = index.search('пропус', { limit: 1 });
    expect(top2?.article.id).toBe('access-lost-pass');
  });

  it('respects category filter and exclusions', () => {
    const hits = index.search('vpn не подключается', { categoryId: 'network', exclude: new Set(['network-vpn-not-connecting']) });
    expect(hits.every((h) => h.article.categoryId === 'network')).toBe(true);
    expect(hits.find((h) => h.article.id === 'network-vpn-not-connecting')).toBeUndefined();
  });

  it('validates catalog integrity: every article references an existing category', () => {
    const ids = new Set(catalog.categories.map((c) => c.id));
    for (const a of catalog.articles) expect(ids.has(a.categoryId)).toBe(true);
  });
});
