import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  sanitizeText,
  sanitizeDeep,
  trimBeforeOpenPlaceholder,
  OBFUSCATION_RULES_VERSION,
  OBFUSCATION_FAILURE_PLACEHOLDER,
  DEFAULT_OBFUSCATION_MAX_INPUT,
} from '../analytics-obfuscation.js';
import { maskSecretsInLongText } from '../long-text-masking.js';

interface Fixture {
  rulesVersion: string;
  failurePlaceholder: string;
  samples: Array<{ name: string; input: string; expected: string }>;
  cuts: Array<{ name: string; input: string; limit: number; expected: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'obfuscation-samples.json'), 'utf8')) as Fixture;

describe('analytics-obfuscation fixture', () => {
  it('pins the rules version and failure placeholder', () => {
    expect(OBFUSCATION_RULES_VERSION).toBe(fixture.rulesVersion);
    expect(OBFUSCATION_FAILURE_PLACEHOLDER).toBe(fixture.failurePlaceholder);
  });

  for (const sample of fixture.samples) {
    it(`sample "${sample.name}" matches byte-for-byte and a second pass is a no-op`, () => {
      const once = sanitizeText(sample.input, 'on');
      expect(once).toBe(sample.expected);
      expect(sanitizeText(once, 'on')).toBe(once);
    });
  }

  for (const cut of fixture.cuts) {
    it(`cut "${cut.name}"`, () => {
      expect(trimBeforeOpenPlaceholder(cut.input, cut.limit)).toBe(cut.expected);
    });
  }
});

describe('analytics-obfuscation modes', () => {
  it('off mode equals plain secret masking', () => {
    const text = 'token=abc123secret mail a@b.io 10.2.3.4';
    expect(sanitizeText(text, 'off')).toBe(maskSecretsInLongText(text));
    expect(sanitizeText(text, 'off')).toContain('a@b.io');
  });

  it('sanitizeDeep walks nested values and leaves non-strings alone', () => {
    const input = { a: 'mail a@b.io', n: 3, list: ['10.2.3.4', { b: 'PROJ-1 x@y.io' }] };
    expect(sanitizeDeep(input, 'on')).toEqual({
      a: 'mail [REDACTED:EMAIL]',
      n: 3,
      list: ['[REDACTED:IP]', { b: 'PROJ-1 [REDACTED:EMAIL]' }],
    });
    expect(input.a).toBe('mail a@b.io');
    expect(sanitizeDeep(input, 'off')).toEqual({ a: 'mail a@b.io', n: 3, list: ['10.2.3.4', { b: 'PROJ-1 x@y.io' }] });
  });

  it('returns the failure placeholder for over-cap input and never the raw text', () => {
    const big = 'x@y.io '.repeat(20);
    expect(sanitizeText(big, 'on', { maxInput: 50 })).toBe(OBFUSCATION_FAILURE_PLACEHOLDER);
  });

  it('returns the failure placeholder when a rule throws', () => {
    const hostile = { toString: () => { throw new Error('boom'); } };
    expect(sanitizeText(hostile as unknown as string, 'on')).toBe(OBFUSCATION_FAILURE_PLACEHOLDER);
  });

  it('survives input that already contains private-use characters', () => {
    expect(sanitizeText(' PROJ-1 0 a@b.io', 'on')).toBe(' PROJ-1 0 [REDACTED:EMAIL]');
  });
});

describe('analytics-obfuscation worst-case timing (AC13)', () => {
  const CEILING_MS = 1500;
  const size = DEFAULT_OBFUSCATION_MAX_INPUT;
  const cases: Array<[string, string]> = [
    ['email local part run', 'a'.repeat(size)],
    ['email near-miss', 'a.'.repeat(size / 2)],
    ['email many @', 'a@'.repeat(size / 2)],
    ['ipv4 digits and dots', '1.'.repeat(size / 2)],
    ['ipv4 almost', '255.255.255.'.repeat(size / 12)],
    ['ipv6 colons', ':'.repeat(size)],
    ['ipv6 hex groups', 'ab:'.repeat(size / 3)],
    ['card digits', '1'.repeat(size)],
    ['card spaced digits', '4 '.repeat(size / 2)],
    ['phone separators', '1 '.repeat(size / 2)],
    ['phone dashes', '1-'.repeat(size / 2)],
    ['iban groups', 'GB82 '.repeat(size / 5)],
    ['iban letters', 'AB12'.repeat(size / 4)],
    ['ticket-like', 'AB-'.repeat(size / 3)],
    ['hash refs', '#1 AB#1 a/b#1 '.repeat(size / 14)],
  ];
  for (const [name, input] of cases) {
    it(`${name} finishes under ${CEILING_MS} ms`, () => {
      const start = performance.now();
      sanitizeText(input, 'on');
      expect(performance.now() - start).toBeLessThan(CEILING_MS);
    });
  }
});
