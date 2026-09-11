import type { ClarifyingField, ExtractRule } from '@helpdesk/shared';

/**
 * AI: Deterministic value extraction for clarifying fields.
 *
 * The model is good at understanding intent but unreliable at pulling exact identifiers ("общежитие 12")
 * out of a sentence - it often answers the question and leaves `fields` empty, which made the assistant
 * ask for something the user had already said. The rules live in the catalog (database), so a new sphere
 * adds its own patterns without touching this file.
 */
export type ExtractResult = {
  /** AI: Значения, распознанные в сообщении, по id поля уточнения. */
  fields: Record<string, string>;
  /**
   * AI: Ставится, когда значение распознано, но в организации не существует (например, общежитие
   * №4).
   */
  reject?: { fieldId: string; value: string; message: string };
};

const MAX_VALUE = 200;

export function extractFields(clarify: ClarifyingField[], text: string): ExtractResult {
  const lower = text.toLowerCase();
  const fields: Record<string, string> = {};
  let reject: ExtractResult['reject'];

  for (const field of clarify) {
    if (!field.extract) {
      // AI: Fields with fixed options ("из дома / из корпуса", "студент / сотрудник"): an option
      // named in the message is the answer - as long as exactly one of them is.
      const mentioned = (field.options ?? []).filter((o) => optionMentioned(o, lower));
      if (mentioned.length === 1) fields[field.id] = mentioned[0]!;
      continue;
    }
    const r = applyRules(rulesOf(field), lower);
    if (r.rejected) {
      // AI: Первое невозможное значение побеждает - сообщаем о нём пользователю вместо поиска
      // решения.
      if (!reject) reject = { fieldId: field.id, ...r.rejected };
      continue;
    }
    if (r.value) fields[field.id] = r.value;
  }

  return { fields, reject };
}

/**
 * AI: The model fills fields too, and it happily copies "корпус 40" from the message. Every value
 * that looks like something a rule knows (a dorm, a building) must pass the same whitelist as text
 * from the user - otherwise it is dropped and reported, so the dialogue asks again instead of
 * sending a request to a place that does not exist.
 */
export function validateFields(
  clarify: ClarifyingField[],
  fields: Record<string, string>,
): ExtractResult {
  const out: Record<string, string> = {};
  let reject: ExtractResult['reject'];
  for (const [id, value] of Object.entries(fields)) {
    const field = clarify.find((f) => f.id === id);
    if (!field?.extract) {
      out[id] = value;
      continue;
    }
    const r = applyRules(rulesOf(field), value.toLowerCase());
    if (r.rejected) {
      if (!reject) reject = { fieldId: id, ...r.rejected };
      continue;
    }
    // AI: Normalised form when a rule recognised it ("общ. 12" -> "общежитие №12"), else as given.
    out[id] = r.value ?? value;
  }
  return { fields: out, reject };
}

/** AI: Нужно ли поле прямо сейчас с учётом того, что уже известно? */
export function isRequired(field: ClarifyingField, fields: Record<string, string>): boolean {
  if (field.required) return true;
  const cond = field.requiredWhen;
  if (!cond) return false;
  const v = fields[cond.field];
  if (!v) return false;
  try {
    return new RegExp(cond.pattern, 'iu').test(v);
  } catch {
    return false;
  }
}

function rulesOf(field: ClarifyingField): ExtractRule[] {
  const e = field.extract;
  return !e ? [] : Array.isArray(e) ? e : [e];
}

function applyRules(
  rules: ExtractRule[],
  lower: string,
): { value?: string; rejected?: { value: string; message: string } } {
  for (const rule of rules) {
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
      return {
        rejected: {
          value,
          message: (
            rule.reject ?? `Значение «${value}» не найдено. Проверьте и напишите ещё раз.`
          ).replaceAll('{value}', value),
        },
      };
    }
    return {
      value: (rule.format ? rule.format.replaceAll('$1', value) : value).slice(0, MAX_VALUE),
    };
  }
  return {};
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
  // AI: `words` содержит только буквы и цифры (см. split выше), поэтому основа безопасна для
  // регулярки.
  return words.some((w) => new RegExp(`(^|[^a-zа-яё0-9])${w.slice(0, 5)}`, 'u').test(lowerText));
}
