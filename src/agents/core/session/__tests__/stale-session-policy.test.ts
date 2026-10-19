import { describe, it, expect } from 'vitest';
import { isSessionStale, DEFAULT_INACTIVITY_THRESHOLD_MS } from '../stale-session-policy.js';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

describe('isSessionStale', () => {
  it('is not stale when inactive for less than the threshold', () => {
    expect(
      isSessionStale({
        now: NOW,
        lastActivityMs: NOW - 10 * 60 * 1000,
        inactivityThresholdMs: 30 * 60 * 1000,
      })
    ).toBe(false);
  });

  it('is stale once inactive for at least the threshold', () => {
    expect(
      isSessionStale({
        now: NOW,
        lastActivityMs: NOW - 31 * 60 * 1000,
        inactivityThresholdMs: 30 * 60 * 1000,
      })
    ).toBe(true);
  });

  it('is stale no matter how long ago activity stopped — overdue reconciliation is not exempt', () => {
    // A session restarted-into weeks after it died is exactly the case this fallback exists
    // to close. Excluding anything "too old" would permanently orphan the sessions most in
    // need of finalization.
    expect(
      isSessionStale({
        now: NOW,
        lastActivityMs: NOW - 30 * 24 * HOUR,
        inactivityThresholdMs: 30 * 60 * 1000,
      })
    ).toBe(true);
  });

  it('exposes the default used by both the CLI and Desktop reconciliation runtimes', () => {
    expect(DEFAULT_INACTIVITY_THRESHOLD_MS).toBe(30 * 60 * 1000);
  });
});
