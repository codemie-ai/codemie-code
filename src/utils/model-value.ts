/**
 * The one rule for a model value (the `-m` flag, `CODEMIE_MODEL`, a request's `model` field).
 *
 * Shape only: nothing is trimmed and no catalog is consulted. Rules run in order and the first match wins:
 * not text, empty, longer than 256 code points, then any whitespace, control, BOM or zero-width space character.
 * The value, or any part of it, never appears in a message.
 */

export const MODEL_VALUE_MAX_LENGTH = 256;

export type ModelValueRule = 'not_text' | 'empty' | 'too_long' | 'invalid_characters';

export interface ModelValueViolation {
  rule: ModelValueRule;
  /** Length in code points; set for every rule but `not_text`. */
  length?: number;
  /** JSON type of a non-text value; set for `not_text`. */
  jsonType?: string;
}

// White_Space and control characters, plus U+FEFF (BOM) and U+200B (zero-width space), which are neither.
const BOM = String.fromCharCode(0xfeff);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const INVALID_CHARACTERS = new RegExp(`[\\p{White_Space}\\p{Cc}${BOM}${ZERO_WIDTH_SPACE}]`, 'u');

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** The first rule `value` breaks, or null when it is a valid model value. */
export function validateModelValue(value: unknown): ModelValueViolation | null {
  if (typeof value !== 'string') return { rule: 'not_text', jsonType: jsonTypeOf(value) };

  // Count by iteration: an astral character is one code point, and no array of a huge value is built.
  let length = 0;
  for (const _ of value) length++;

  if (length === 0) return { rule: 'empty', length };
  if (length > MODEL_VALUE_MAX_LENGTH) return { rule: 'too_long', length };
  if (INVALID_CHARACTERS.test(value)) return { rule: 'invalid_characters', length };
  return null;
}

const RULE_DESCRIPTIONS: Record<Exclude<ModelValueRule, 'not_text'>, string> = {
  empty: 'empty',
  too_long: `longer than ${MODEL_VALUE_MAX_LENGTH} characters`,
  invalid_characters: 'contains whitespace or control characters',
};

/** The user-facing message of a violation: the rule and the length (or type), never the value. */
export function describeModelValueViolation(violation: ModelValueViolation): string {
  if (violation.rule === 'not_text') {
    return `Invalid model value: must be text. Received type: ${violation.jsonType}.`;
  }
  return `Invalid model value: ${RULE_DESCRIPTIONS[violation.rule]}. Received length: ${violation.length}.`;
}
