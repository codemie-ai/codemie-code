import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildResumeEnvOverride, shouldBlockNonInteractiveResume } from '../AgentCLI.js';

describe('buildResumeEnvOverride', () => {
  it('returns CODEMIE_CONV_SYNC_DISABLED=1 for an external confirmed resume', () => {
    const env = buildResumeEnvOverride(true);
    expect(env).toEqual({ CODEMIE_CONV_SYNC_DISABLED: '1' });
  });

  it('returns empty object for a CodeMie-owned session', () => {
    const env = buildResumeEnvOverride(false);
    expect(env).toEqual({});
  });
});

describe('shouldBlockNonInteractiveResume', () => {
  let origNoPrompts: string | undefined;

  beforeEach(() => {
    origNoPrompts = process.env.CODEMIE_NO_PROMPTS;
  });

  afterEach(() => {
    if (origNoPrompts === undefined) {
      delete process.env.CODEMIE_NO_PROMPTS;
    } else {
      process.env.CODEMIE_NO_PROMPTS = origNoPrompts;
    }
  });

  it('returns true when CODEMIE_NO_PROMPTS=1', () => {
    process.env.CODEMIE_NO_PROMPTS = '1';
    expect(shouldBlockNonInteractiveResume()).toBe(true);
  });

  it('returns true when stdin is not a TTY (test environment default)', () => {
    delete process.env.CODEMIE_NO_PROMPTS;
    // In Vitest, process.stdin.isTTY is false/undefined — non-interactive by default
    expect(shouldBlockNonInteractiveResume()).toBe(true);
  });
});
