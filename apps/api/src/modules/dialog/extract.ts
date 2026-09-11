import type { ClarifyingField } from '@helpdesk/shared';

/**
 * AI: Deterministic value extraction for clarifying fields.
 *
 * The model is good at understanding intent but unreliable at pulling exact identifiers ("общежитие 12")
 * out of a sentence - it often answers the question and leaves `fields` empty, which made the assistant
 * ask for something the user had already said. The rules live in the catalog (database), so a new sphere
 * adds its own patterns without touching this file.
 */
export type ExtractResult = {
  /** AI: Values recognised in the message, keyed by clarifying-field id. */
  fields: Record<string, string>;
  /** AI: Set when a value was recognised but does not exist in the organisation (e.g. dorm N4). */
  reject?: { fieldId: string; value: string; message: string };
};

const MAX_VALUE = 200;

export function extractFields(clarify: ClarifyingField[], text: string): ExtractResult {
  const lower = text.toLowerCase();
  const fields: Record<string, string> = {};
  let reject: ExtractResult['reject'];

  for (const field of clarify) {
    const rule = field.extract;
    if (!rule) {
      // AI: Fields with fixed options ("из дома / из корпуса", "студент / сотрудник"): an option
      // named in the message is the answer - as long as exactly one of them is.
      const mentioned = (field.options ?? []).filter((o) => optionMentioned(o, lower));
      if (mentioned.length === 1) fields[field.id] = mentioned[0]!;
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, 'iu');
    } catch {
      continue; // A broken pattern in the catalog must not break the dialogue.
    }
    const m = re.exec(lower);
    if (!m) continue;
    const value = m.slice(1).find((g) => g !== undefined && g !== '');
    if (!value) continue;

    if (rule.allow && !rule.allow.includes(value)) {
      // AI: The first impossible value wins - we tell the user about it instead of searching for a solution.
      if (!reject && rule.reject) {
        reject = { fieldId: field.id, value, message: rule.reject.replaceAll('{value}', value) };
      }
      continue;
    }
    fields[field.id] = (rule.format ? rule.format.replaceAll('$1', value) : value).slice(
      0,
      MAX_VALUE,
    );
  }

  return { fields, reject };
}

/**
 * AI: "Из дома / удалённо" is mentioned when a meaningful word of it starts a word in the text.
 * Matching on the first five letters absorbs Russian case endings ("общежития" ~ "в общежитии").
 */
export function optionMentioned(option: string, lowerText: string): boolean {
  const words = option
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/)
    .filter((w) => w.length >= 3 && !['или', 'для', 'при', 'нет'].includes(w));
  // AI: `words` contains letters and digits only (split above), so the stem is regex-safe.
  return words.some((w) => new RegExp(`(^|[^a-zа-яё0-9])${w.slice(0, 5)}`, 'u').test(lowerText));
}
