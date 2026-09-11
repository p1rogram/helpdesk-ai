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
    if (!rule) continue;
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
      // The first impossible value wins - we tell the user about it instead of searching for a solution.
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
