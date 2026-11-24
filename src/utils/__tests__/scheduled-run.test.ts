/**
 * Unattended scheduled start detection
 *
 * The OS scheduler job invokes `<node> <realpath of bin/codemie.js>
 * analytics sync run --scheduled`. These tests pin down the argv shape
 * that must be recognized so `bin/codemie.js` can skip interactive
 * startup work (update checks, what's-new notice) and run migrations
 * silently for that unattended invocation only.
 */

import { describe, it, expect } from 'vitest';
import { isScheduledSyncRun } from '../scheduled-run.js';

describe('isScheduledSyncRun', () => {
  it('returns true for the scheduled job argv shape', () => {
    const argv = ['node', 'codemie', 'analytics', 'sync', 'run', '--scheduled'];
    expect(isScheduledSyncRun(argv)).toBe(true);
  });

  it('returns true when --scheduled appears before run, as long as order of analytics/sync/run holds', () => {
    const argv = ['node', 'codemie', 'analytics', 'sync', 'run', '--other', '--scheduled'];
    expect(isScheduledSyncRun(argv)).toBe(true);
  });

  it('returns false for manual `sync run` (no --scheduled)', () => {
    const argv = ['node', 'codemie', 'analytics', 'sync', 'run'];
    expect(isScheduledSyncRun(argv)).toBe(false);
  });

  it('returns false for --scheduled without run', () => {
    const argv = ['node', 'codemie', 'analytics', 'sync', '--scheduled'];
    expect(isScheduledSyncRun(argv)).toBe(false);
  });

  it('returns false for --scheduled with run but no sync', () => {
    const argv = ['node', 'codemie', 'analytics', 'run', '--scheduled'];
    expect(isScheduledSyncRun(argv)).toBe(false);
  });

  it('returns false for an unrelated command', () => {
    const argv = ['node', 'codemie', 'doctor'];
    expect(isScheduledSyncRun(argv)).toBe(false);
  });

  it('returns false for an empty argv', () => {
    expect(isScheduledSyncRun([])).toBe(false);
  });
});
