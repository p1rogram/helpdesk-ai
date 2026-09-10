import type { Tone } from '@helpdesk/shared';

/**
 * Cheap, deterministic pre-checks that run before any LLM call.
 * - profanity / aggression -> tone hint (the model confirms, engine decides what to do)
 * - prompt-injection markers -> logged metric; the architecture already treats user text as data
 * Nothing here blocks the user: an upset person still gets help, just with a calmer voice.
 */

// Stems, normalised (ё->е, latin look-alikes). Intentionally short - false positives cost more than misses.
const PROFANITY_STEMS = [
  'бля', 'блят', 'блт', 'хрен', 'хуй', 'хуе', 'хуя', 'пизд', 'ебал', 'ебан', 'ебат', 'ебт', 'ёбан', 'заеб', 'уеб', 'пидор', 'пидар',
  'мудак', 'мудил', 'сука', 'суки', 'сучк', 'гандон', 'говн', 'дерьм', 'жопа', 'нахер', 'нахуй', 'похуй', 'хер',
  'долбо', 'дебил', 'идиот', 'тупой', 'тупые', 'fuck', 'shit', 'bitch',
];

const AGGRESSION_MARKERS = [
  'бесит', 'достал', 'задолбал', 'надоел', 'ужас', 'кошмар', 'сколько можно', 'опять не работает', 'снова не работает',
  'ничего не работает', 'вы вообще', 'бардак', 'позор', '!!!', 'срочно!!!', 'немедленно',
];

const INJECTION_MARKERS = [
  'ignore previous', 'ignore all previous', 'disregard', 'system prompt', 'you are now', 'забудь инструкции',
  'игнорируй инструкции', 'игнорируй предыдущие', 'ты теперь', 'покажи системный промпт', 'выведи промпт',
  'developer mode', 'jailbreak',
];

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[@4]/g, 'а')
    .replace(/[0]/g, 'о')
    .replace(/[*.\-_]/g, '');
}

export interface SafetyReport {
  profanity: boolean;
  aggressive: boolean;
  injectionAttempt: boolean;
  toneHint: Tone;
}

export function inspectMessage(text: string): SafetyReport {
  const n = normalise(text);
  const raw = text.toLowerCase();
  const profanity = PROFANITY_STEMS.some((s) => n.includes(s));
  const aggressive = AGGRESSION_MARKERS.some((m) => raw.includes(m)) || /[А-ЯA-Z]{6,}/.test(text);
  const injectionAttempt = INJECTION_MARKERS.some((m) => raw.includes(m));
  const toneHint: Tone = profanity ? 'abusive' : aggressive ? 'frustrated' : 'neutral';
  return { profanity, aggressive, injectionAttempt, toneHint };
}

export function strongerTone(a: Tone, b: Tone): Tone {
  const rank: Record<Tone, number> = { neutral: 0, frustrated: 1, abusive: 2 };
  return rank[a] >= rank[b] ? a : b;
}
