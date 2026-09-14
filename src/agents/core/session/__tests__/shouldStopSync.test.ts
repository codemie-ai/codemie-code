import { describe, it, expect } from 'vitest';
import { shouldStopSync } from '../BaseProcessor.js';

describe('shouldStopSync', () => {
  const baseContext = {
    apiBaseUrl: 'https://api.example.com',
    cookies: '',
    clientType: 'codemie-cli',
    version: '1.0.0',
    dryRun: false,
  };

  it('returns false when neither deadline nor abort signal is set', () => {
    expect(shouldStopSync(baseContext)).toBe(false);
  });

  it('returns true when the sync deadline is in the past', () => {
    expect(shouldStopSync({ ...baseContext, syncDeadlineMs: Date.now() - 1 })).toBe(true);
  });

  it('returns false when the sync deadline is in the future', () => {
    expect(shouldStopSync({ ...baseContext, syncDeadlineMs: Date.now() + 60_000 })).toBe(false);
  });

  it('returns true when the abort signal is aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(shouldStopSync({ ...baseContext, abortSignal: controller.signal })).toBe(true);
  });

  it('returns false when the abort signal is not aborted', () => {
    const controller = new AbortController();
    expect(shouldStopSync({ ...baseContext, abortSignal: controller.signal })).toBe(false);
  });
});
