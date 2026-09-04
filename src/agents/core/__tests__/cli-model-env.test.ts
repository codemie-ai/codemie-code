import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyCliModelEnv } from '../cli-model-env.js';

describe('applyCliModelEnv', () => {
  beforeEach(() => { delete process.env.CODEMIE_CLI_MODEL; });
  afterEach(() => { delete process.env.CODEMIE_CLI_MODEL; });

  it('sets CODEMIE_CLI_MODEL to the trimmed explicit model', () => {
    applyCliModelEnv('  claude-opus-4-5  ');
    expect(process.env.CODEMIE_CLI_MODEL).toBe('claude-opus-4-5');
  });

  it('leaves CODEMIE_CLI_MODEL unset when no model is given', () => {
    applyCliModelEnv(undefined);
    expect(process.env.CODEMIE_CLI_MODEL).toBeUndefined();
  });

  it('CLEARS a pre-existing (e.g. shell-exported) value when no model is given', () => {
    process.env.CODEMIE_CLI_MODEL = 'stale-from-shell';
    applyCliModelEnv(undefined);
    expect(process.env.CODEMIE_CLI_MODEL).toBeUndefined();
  });

  it('clears a pre-existing value before applying an empty/whitespace model', () => {
    process.env.CODEMIE_CLI_MODEL = 'stale-from-shell';
    applyCliModelEnv('   ');
    expect(process.env.CODEMIE_CLI_MODEL).toBeUndefined();
  });

  it('ignores non-string input', () => {
    applyCliModelEnv(42);
    expect(process.env.CODEMIE_CLI_MODEL).toBeUndefined();
  });
});
