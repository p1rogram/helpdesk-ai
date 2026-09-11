import { describe, expect, it } from 'vitest';
import { connectDb, ensureSchema } from '../db/client.js';
import { tenants } from '../db/schema.js';
import { chunkText, stripBoilerplate } from '../modules/rag/chunker.js';
import { RagService, redactNames, type Embedder } from '../modules/rag/index.js';
import { findPersonalData } from '../modules/rag/redact.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('chunker', () => {
  it('keeps the heading with every chunk of its section', () => {
    const text = [
      'Минералогический музей',
      'Музей расположен в учебном корпусе №1 и открыт для организованных групп по предварительной записи по телефону. '.repeat(
        3,
      ),
      'Палеонтологический музей',
      'Второй музей находится в том же корпусе и также принимает группы по записи; экспозиция включает более тысячи образцов. '.repeat(
        3,
      ),
    ].join('\n');
    const chunks = chunkText(text, { target: 200, max: 250 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.section).toBe('Минералогический музей');
    expect(chunks.at(-1)!.section).toBe('Палеонтологический музей');
  });

  it('cuts an oversized paragraph at sentence boundaries with overlap', () => {
    const long = Array.from(
      { length: 30 },
      (_, i) => `Предложение номер ${i} содержит некоторый полезный факт.`,
    ).join(' ');
    const chunks = chunkText(long, { target: 300, max: 300, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(340);
  });

  it('drops menu lines shared by many pages but keeps field labels', () => {
    const menu = 'Университет\nМиссия\nРекторат\n';
    const pages = Array.from(
      { length: 6 },
      (_, i) => `${menu}Адрес\nул. Ленина, ${i}\nУникальный текст страницы ${i}`,
    );
    const cleaned = stripBoilerplate(pages, { minPages: 4 });
    expect(cleaned[0]).not.toContain('Ректорат');
    expect(cleaned[0]).toContain('Адрес');
    expect(cleaned[0]).toContain('Уникальный текст страницы 0');
  });
});

/** AI: Deterministic toy embedder: a bag of hand-picked concepts, so paraphrases land close together. */
class ToyEmbedder implements Embedder {
  readonly model = 'toy';
  readonly dims = 3;
  private readonly concepts: [RegExp, number][] = [
    [/вход|войти|зайти|логин|авториз/i, 0],
    [/общежит|комнат|заселен/i, 1],
    [/экскурс|музей/i, 2],
  ];
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = [0, 0, 0];
      for (const [re, i] of this.concepts) if (re.test(t)) v[i] = 1;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}

describe('RagService', () => {
  const docs = [
    {
      url: 'https://help.example/login',
      title: 'Ошибка авторизации в личном кабинете',
      text: 'Если при вводе логина и пароля возникает ошибка, проверьте раскладку клавиатуры и Caps Lock, затем сбросьте пароль.',
      audience: 'internal' as const,
    },
    {
      url: 'https://example/excursion',
      title: 'Экскурсии в музей',
      text: 'Записаться на экскурсию в музей можно по телефону; вход бесплатный, посещение группами по предварительной записи.',
      audience: 'public' as const,
    },
    {
      url: 'https://example/dorm',
      title: 'Общежития',
      text: 'Заселение в общежитие проходит в отделе студенческих общежитий; комнаты распределяются по приказу о заселении.',
      audience: 'public' as const,
    },
  ];

  it('ingests, fuses lexical and dense hits, and scopes guests to public pages', async () => {
    const h = await connectDb({
      url: undefined,
      pgliteDir: mkdtempSync(path.join(tmpdir(), 'rag-')),
    });
    await ensureSchema(h.db);
    await h.db.insert(tenants).values({ id: 't', sphere: 'test', organisation: 'org' });
    const rag = new RagService(h.db, new ToyEmbedder(), { info: () => {}, warn: () => {} });

    expect(await rag.ingest('t', docs)).toEqual({ chunks: 3, embedded: 3 });
    // the same corpus again: nothing changed, nothing re-embedded
    expect(await rag.ingest('t', docs)).toEqual({ chunks: 3, embedded: 0 });

    // paraphrase without shared words -> found by the dense half
    const dense = await rag.search('t', 'не могу зайти', { limit: 3 });
    expect(dense[0]?.url).toBe('https://help.example/login');

    // exact words -> lexical + dense agree
    const both = await rag.search('t', 'экскурсия в музей', { limit: 3 });
    expect(both[0]?.url).toBe('https://example/excursion');
    expect(both[0]!.lexical).toBeGreaterThan(0);

    // guest never sees internal documentation
    const guest = await rag.search('t', 'не могу зайти логин', { scope: 'guest', limit: 3 });
    expect(guest.every((p) => !p.url.startsWith('https://help.example'))).toBe(true);

    await h.close();
  });
});

describe('markdown documents', () => {
  it('reads docs/*.md with a front-matter header', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'raw-'));
    mkdirSync(path.join(dir, 'docs'));
    const header = [
      '---',
      'title: Порядок выплат',
      'source: https://example.org/order',
      'audience: internal',
      '---',
    ];
    writeFileSync(
      path.join(dir, 'docs', 'order.md'),
      [...header, '# Раздел', 'Текст документа.', ''].join('\n'),
    );
    writeFileSync(path.join(dir, 'docs', 'broken.md'), 'без шапки');
    const rag = new RagService(null as never, new ToyEmbedder(), {
      info: () => {},
      warn: () => {},
    });
    expect(await rag.loadRawDir(dir)).toEqual([
      {
        url: 'https://example.org/order',
        title: 'Порядок выплат',
        text: '# Раздел\nТекст документа.',
        audience: 'internal',
      },
    ]);
  });
});

describe('redactNames', () => {
  it('removes full names and initials but keeps roles and office contacts', () => {
    const src =
      'Проректор по управлению кампусом Высокоморный Владимир Сергеевич принимает каждый первый четверг, каб. 312, 8 (3822) 70-17-77. ' +
      'Заведующая: Казакова Елена Геннадьевна (+7 (3822) 60-64-43, eleka@tpu.ru). Вопросы — Бредихина Г. В., bgv@tpu.ru.';
    const out = redactNames(src);
    expect(out).not.toMatch(/Высокоморный|Казакова|Бредихина/);
    expect(out).toContain('Проректор по управлению кампусом принимает каждый первый четверг');
    expect(out).toContain('(+7 (3822) 60-64-43, eleka@tpu.ru)');
    expect(out).toContain('bgv@tpu.ru');
  });

  it('catches inverted order, first-name + surname pairs and mobile numbers', () => {
    const out = redactNames(
      'Екатерина Валериевна Сулема, руководитель. Контакты: Данил Казаков, тел. +7-923-407-1493; Новикова Юлия.',
    );
    expect(out).not.toMatch(/Сулема|Казаков|Новикова|923/);
    expect(out).toContain('руководитель');
  });

  it('keeps streets and places named after people', () => {
    const t =
      'Общежитие №15: ул. Аркадия Иванова, 8. Мемориальный кабинет В. А. Обручева, корпус имени Кижнера.';
    expect(redactNames(t)).toBe(t);
    expect(findPersonalData(t)).toEqual([]);
  });

  it('leaves ordinary text alone', () => {
    const t = 'Общежитие №12: ул. Вершинина, 37. Отдел студенческих общежитий, +7 (3822) 60-62-05.';
    expect(redactNames(t)).toBe(t);
  });
});
