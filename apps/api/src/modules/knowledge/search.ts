import type { KbArticle } from '@helpdesk/shared';

/**
 * AI: Лёгкий лексический поиск по базе знаний тенанта (оценка в духе BM25 с грубым префиксным
 * стеммером для русского). Доли миллисекунды на тысячи статей, детерминированно, без внешних
 * сервисов. Путь роста: эмбеддинги pgvector за той же сигнатурой `search()`.
 */
export interface ScoredArticle {
  article: KbArticle;
  score: number;
}

const STOP = new Set([
  'и',
  'в',
  'во',
  'не',
  'что',
  'он',
  'на',
  'я',
  'с',
  'со',
  'как',
  'а',
  'то',
  'все',
  'она',
  'так',
  'его',
  'но',
  'да',
  'ты',
  'к',
  'у',
  'же',
  'вы',
  'за',
  'бы',
  'по',
  'только',
  'ее',
  'мне',
  'было',
  'вот',
  'от',
  'меня',
  'еще',
  'нет',
  'о',
  'из',
  'ему',
  'теперь',
  'когда',
  'даже',
  'ну',
  'вдруг',
  'ли',
  'если',
  'уже',
  'или',
  'ни',
  'быть',
  'был',
  'него',
  'до',
  'вас',
  'нибудь',
  'опять',
  'уж',
  'вам',
  'ведь',
  'там',
  'потом',
  'себя',
  'ничего',
  'ей',
  'может',
  'они',
  'тут',
  'где',
  'есть',
  'надо',
  'ней',
  'для',
  'мы',
  'тебя',
  'их',
  'чем',
  'была',
  'сам',
  'чтоб',
  'без',
  'будто',
  'чего',
  'раз',
  'тоже',
  'себе',
  'под',
  'будет',
  'ж',
  'тогда',
  'кто',
  'этот',
  'того',
  'потому',
  'этого',
  'какой',
  'совсем',
  'ним',
  'здесь',
  'этом',
  'один',
  'почти',
  'мой',
  'тем',
  'чтобы',
  'нее',
  'сейчас',
  'были',
  'куда',
  'зачем',
  'всех',
  'никогда',
  'можно',
  'при',
  'наконец',
  'два',
  'об',
  'другой',
  'хоть',
  'после',
  'над',
  'больше',
  'тот',
  'через',
  'эти',
  'нас',
  'про',
  'всего',
  'них',
  'какая',
  'много',
  'разве',
  'эту',
  'моя',
  'свою',
  'этой',
  'перед',
  'иногда',
  'лучше',
  'чуть',
  'том',
  'нельзя',
  'такой',
  'им',
  'более',
  'всегда',
  'конечно',
  'всю',
  'между',
  'у',
  'мне',
  'мой',
  'моё',
  'мои',
  'the',
  'a',
  'an',
  'is',
  'to',
  'of',
  // AI: разговорный мусор без тематического сигнала
  'могу',
  'можете',
  'нужно',
  'нужен',
  'нужна',
  'хочу',
  'помогите',
  'пожалуйста',
  'здравствуйте',
  'добрый',
  'день',
  'подскажите',
  'вопрос',
  'проблема',
  'почему',
  'какой',
  'какие',
  'это',
  'мне',
  'меня',
  'него',
  'него',
]);

export function tokenize(text: string, opts: { keepShort?: boolean } = {}): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter((t) => (opts.keepShort ? t.length > 0 : t.length > 1) && !STOP.has(t))
    .map(stem);
}

/** AI: Prefix stemmer: good enough to match "подключиться" ~ "подключается" ~ "подключение". */
function stem(t: string): string {
  if (/^[a-z0-9]+$/.test(t)) return t; // latin tokens (vpn, moodle, wifi) untouched
  return t.length > 6 ? t.slice(0, 6) : t.length > 4 ? t.slice(0, 4) : t;
}

interface IndexedDoc {
  article: KbArticle;
  tf: Map<string, number>;
  len: number;
}

export class KnowledgeIndex {
  private readonly docs: IndexedDoc[] = [];
  private readonly df = new Map<string, number>();
  private avgLen = 1;

  constructor(articles: KbArticle[]) {
    for (const a of articles) {
      // AI: Веса полей: заголовок и симптомы описывают проблему, шаги - способ починки; слово в
      // шагах не должно перевешивать то же слово в заголовке другой статьи.
      const tf = new Map<string, number>();
      let len = 0;
      const add = (text: string, w: number) => {
        for (const t of tokenize(text)) {
          tf.set(t, (tf.get(t) ?? 0) + w);
          len += w;
        }
      };
      add(a.title, 3);
      add(a.symptoms, 2);
      add(a.steps.join(' '), 0.4);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ article: a, tf, len });
    }
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }

  search(
    query: string,
    opts: { categoryId?: string; limit?: number; exclude?: Set<string> } = {},
  ): ScoredArticle[] {
    const q = tokenize(query, { keepShort: true });
    if (!q.length) return [];
    // AI: Autocomplete behaviour: a query token matches an index term exactly or as its prefix
    // ("v" -> vpn/vap, "vp" -> vpn, "мудл" -> мудла). Prefix hits are weighted below exact ones.
    const terms = [...this.df.keys()];
    const expansions = q.map((t) => {
      const exact = this.df.has(t);
      const pref = terms.filter((x) => x !== t && x.startsWith(t));
      return { exact: exact ? t : null, prefixes: pref };
    });
    const N = this.docs.length;
    const k1 = 1.4;
    const b = 0.75;
    const bm25 = (t: string, f: number, d: IndexedDoc) => {
      const df = this.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      return idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen)));
    };
    const out: ScoredArticle[] = [];
    for (const d of this.docs) {
      if (opts.categoryId && d.article.categoryId !== opts.categoryId) continue;
      if (opts.exclude?.has(d.article.id)) continue;
      let score = 0;
      for (const e of expansions) {
        let best = 0;
        if (e.exact) {
          const f = d.tf.get(e.exact);
          if (f) best = bm25(e.exact, f, d);
        }
        for (const p of e.prefixes) {
          const f = d.tf.get(p);
          if (f) best = Math.max(best, 0.6 * bm25(p, f, d));
        }
        score += best;
      }
      if (score > 0) out.push({ article: d.article, score });
    }
    out.sort((x, y) => y.score - x.score);
    return out.slice(0, opts.limit ?? 5);
  }
}
