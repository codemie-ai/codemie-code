import { describe, it, expect } from 'vitest';
import { validateModelValue, describeModelValueViolation } from '../model-value.js';
import { MODEL_VALUE_CASES, leakProbe } from './model-value-cases.js';

const codePoints = (s: string): number => Array.from(s).length;

const RULE_WORDS: Record<string, string> = {
  empty: 'empty',
  too_long: 'longer than 256 characters',
  invalid_characters: 'contains whitespace or control characters',
};

describe('validateModelValue', () => {
  for (const row of MODEL_VALUE_CASES) {
    it(`${row.valid ? 'accepts' : 'rejects'}: ${row.name}`, () => {
      const violation = validateModelValue(row.value);
      if (row.valid) {
        expect(violation).toBeNull();
        return;
      }
      expect(violation?.rule).toBe(row.rule);
      if (row.nonText) return;
      expect(violation?.length).toBe(codePoints(row.value as string));
    });
  }

  it('reports the JSON type of a non-text value', () => {
    const types = MODEL_VALUE_CASES.filter(c => c.nonText).map(c => validateModelValue(c.value)?.jsonType);
    expect(types).toEqual(['null', 'number', 'boolean', 'array', 'object']);
  });

  it('applies the length rule before the character rule', () => {
    expect(validateModelValue('a b'.repeat(100))?.rule).toBe('too_long');
  });

  it('counts a multi-megabyte value and keeps the message a constant size', () => {
    const violation = validateModelValue('z'.repeat(5_000_000));
    expect(violation).toEqual({ rule: 'too_long', length: 5_000_000 });
    expect(describeModelValueViolation(violation!).length).toBeLessThan(120);
  });

  it('names the rule and length in the message and never echoes the value', () => {
    for (const row of MODEL_VALUE_CASES.filter(c => !c.valid && !c.nonText)) {
      const violation = validateModelValue(row.value)!;
      const message = describeModelValueViolation(violation);
      expect(message).toContain('Invalid model value: ');
      expect(message).toContain(RULE_WORDS[violation.rule]);
      expect(message).toContain(`Received length: ${violation.length}.`);
      const probe = leakProbe(row.value as string);
      if (probe) expect(message).not.toContain(probe);
    }
  });

  it('reports the type, not a length, for a non-text value', () => {
    expect(describeModelValueViolation({ rule: 'not_text', jsonType: 'array' })).toBe(
      'Invalid model value: must be text. Received type: array.'
    );
  });
});
