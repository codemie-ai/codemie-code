/**
 * Regression tests for the empty-safe test-env resolvers.
 *
 * Guards the failure mode that broke the whole agent suite before the 0.15.0
 * release: CodeMie exports its full CODEMIE_* block into the shell of every
 * agent session it launches, and the anthropic-subscription provider
 * deliberately blanks CODEMIE_MODEL (see
 * src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts).
 * Running `npm test` from inside such a session inherited
 * CODEMIE_MODEL='', and the old `process.env.CODEMIE_MODEL ?? 'claude-sonnet-4-6'`
 * coalescing let that empty string beat the default — every generated profile
 * was written with no model and the agent tests died with
 * "Configuration incomplete / Missing: model".
 *
 * Synthetic variable names are used throughout so the assertions hold whether
 * or not the developer has a .env.test.local (which takes priority for real keys).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getTestEnvValue } from '../helpers/test-env.js';

const PRIMARY = 'CI_PROBE_TEST_ENV_VALUE_PRIMARY';
const ALIAS = 'CI_PROBE_TEST_ENV_VALUE_ALIAS';
const TOUCHED = [PRIMARY, ALIAS];

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
});

describe('getTestEnvValue', () => {
  it('returns the default when the variable is unset', () => {
    expect(getTestEnvValue(PRIMARY, 'fallback-value')).toBe('fallback-value');
  });

  it('returns the value when the variable holds a real value', () => {
    process.env[PRIMARY] = 'real-value';
    expect(getTestEnvValue(PRIMARY, 'fallback-value')).toBe('real-value');
  });

  // The exact regression: set-but-empty must behave as absent, not as "".
  it('treats an inherited empty string as absent and uses the default', () => {
    process.env[PRIMARY] = '';
    expect(getTestEnvValue(PRIMARY, 'fallback-value')).toBe('fallback-value');
  });

  it('treats a whitespace-only value as absent and uses the default', () => {
    process.env[PRIMARY] = '   ';
    expect(getTestEnvValue(PRIMARY, 'fallback-value')).toBe('fallback-value');
  });

  it('falls back to an alias when the primary name is unset', () => {
    process.env[ALIAS] = 'alias-value';
    expect(getTestEnvValue(PRIMARY, 'fallback-value', [ALIAS])).toBe('alias-value');
  });

  it('falls back to an alias when the primary name is set but empty', () => {
    process.env[PRIMARY] = '';
    process.env[ALIAS] = 'alias-value';
    expect(getTestEnvValue(PRIMARY, 'fallback-value', [ALIAS])).toBe('alias-value');
  });

  it('prefers the primary name over an alias when both hold real values', () => {
    process.env[PRIMARY] = 'primary-value';
    process.env[ALIAS] = 'alias-value';
    expect(getTestEnvValue(PRIMARY, 'fallback-value', [ALIAS])).toBe('primary-value');
  });

  it('falls through to the default when both the primary and alias are empty', () => {
    process.env[PRIMARY] = '';
    process.env[ALIAS] = '  ';
    expect(getTestEnvValue(PRIMARY, 'fallback-value', [ALIAS])).toBe('fallback-value');
  });

  it('trims surrounding whitespace from a real value', () => {
    process.env[PRIMARY] = '  padded-value  ';
    expect(getTestEnvValue(PRIMARY, 'fallback-value')).toBe('padded-value');
  });
});
