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

/**
 * AI: Синонимы и разговорные формы сводятся к одному терму до стемминга, чтобы «вайфай», «wi-fi»
 * и «wifi» искали одно и то же. Латинские и русские написания одного продукта - сюда же.
 */
const SYNONYMS: Record<string, string> = {
  вайфай: 'wifi',
  вай: 'wifi',
  фай: 'wifi',
  wi: 'wifi',
  fi: 'wifi',
  впн: 'vpn',
  мудл: 'moodle',
  мудлe: 'moodle',
  общага: 'общежитие',
  общаге: 'общежитие',
  общаги: 'общежитие',
  общагу: 'общежитие',
  общ: 'общежитие',
  лк: 'кабинет',
  личка: 'кабинет',
  инет: 'интернет',
  инета: 'интернет',
  инету: 'интернет',
  комп: 'компьютер',
  компа: 'компьютер',
  ноут: 'ноутбук',
  ноута: 'ноутбук',
  нб: 'ноутбук',
  препод: 'преподаватель',
  препода: 'преподаватель',
  стипуха: 'стипендия',
  стипухи: 'стипендия',
  стипа: 'стипендия',
  универ: 'университет',
  универа: 'университет',
  пасс: 'пароль',
  пароля: 'пароль',
  логина: 'логин',
  сдо: 'moodle',
  тпу: 'тпу',
};

export function tokenize(text: string, opts: { keepShort?: boolean } = {}): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter((t) => (opts.keepShort ? t.length > 0 : t.length > 1) && !STOP.has(t))
    .map((t) => SYNONYMS[t] ?? t)
    .map(stem);
}

/**
 * AI: Опечатка в одном символе («стипндия», «общежитее»): перебираем все варианты слова с одной
 * правкой (удаление, перестановка, замена, вставка) и берём первый, чей стем есть в индексе.
 * Только для слов от 5 символов - короткие слишком легко перепутать. ~600 проверок по хэшу.
 */
export function closestTerm(raw: string, known: (stem: string) => boolean): string | null {
  if (raw.length < 5) return null;
  const abc = 'абвгдежзийклмнопрстуфхцчшщъыьэюяabcdefghijklmnopqrstuvwxyz';
  const seen = new Set<string>();
  const check = (v: string): string | null => {
    if (v === raw || seen.has(v)) return null;
    seen.add(v);
    const st = stem(v);
    return known(st) ? st : null;
  };
  for (let i = 0; i < raw.length; i++) {
    const hit = check(raw.slice(0, i) + raw.slice(i + 1));
    if (hit) return hit;
  }
  for (let i = 0; i < raw.length - 1; i++) {
    const hit = check(raw.slice(0, i) + raw[i + 1] + raw[i] + raw.slice(i + 2));
    if (hit) return hit;
  }
  for (let i = 0; i < raw.length; i++) {
    for (const c of abc) {
      const hit = check(raw.slice(0, i) + c + raw.slice(i + 1));
      if (hit) return hit;
    }
  }
  for (let i = 0; i <= raw.length; i++) {
    for (const c of abc) {
      const hit = check(raw.slice(0, i) + c + raw.slice(i));
      if (hit) return hit;
    }
  }
  return null;
}

/** AI: Токены запроса с исправлением опечаток: стем есть в индексе - берём его, нет - ищем правку. */
export function tokenizeQuery(text: string, known: (stem: string) => boolean): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter((t) => t.length > 0 && !STOP.has(t))
    .map((t) => SYNONYMS[t] ?? t)
    .map((t) => {
      const st = stem(t);
      return known(st) ? st : (closestTerm(t, known) ?? st);
    });
}

/** AI: Префиксный стеммер: достаточно, чтобы «подключение» ~ «подключения» ~ «подключить». */
function stem(t: string): string {
  if (/^[a-z0-9]+$/.test(t)) return t; // латинские токены (vpn, moodle, wifi) не трогаем
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
    // AI: Терм «известен», если есть точно или как префикс (автодополнение «vp» -> vpn) - тогда
    // исправление опечаток не вмешивается.
    const known = (st: string) =>
      this.df.has(st) || (st.length >= 2 && [...this.df.keys()].some((k) => k.startsWith(st)));
    const q = tokenizeQuery(query, known);
    if (!q.length) return [];
    // AI: Поведение автодополнения: токен запроса совпадает с термом индекса точно или как его
    // префикс («v» -> vpn/vap, «vp» -> vpn, «прин» -> принтер). Префиксные попадания весят меньше
    // точных.
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
