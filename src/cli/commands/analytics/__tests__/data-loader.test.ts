/**
 * Unit tests for MetricsDataLoader's session-id filtering — regression coverage for
 * the bug where `--session <id>` silently matched every session.
 */

import { describe, it, expect } from 'vitest';
import { MetricsDataLoader, type RawSessionData } from '../data-loader.js';

function rawSession(sessionId: string): RawSessionData {
  return {
    sessionId,
    startEvent: {
      recordId: sessionId,
      type: 'session_start',
      timestamp: 1000,
      codeMieSessionId: sessionId,
      agentName: 'claude',
      syncStatus: 'synced',
      data: {
        provider: 'anthropic',
        workingDirectory: '/tmp/project',
        startTime: 1000,
      },
    },
    deltas: [],
  };
}

describe('MetricsDataLoader.sessionMatchesFilter', () => {
  it('matches when sessionId equals the filter sessionId', () => {
    const loader = new MetricsDataLoader('/nonexistent');
    const session = rawSession('abc-123');
    expect(loader.sessionMatchesFilter(session, { sessionId: 'abc-123' })).toBe(true);
  });

  it('rejects when sessionId differs from the filter sessionId', () => {
    const loader = new MetricsDataLoader('/nonexistent');
    const session = rawSession('abc-123');
    expect(loader.sessionMatchesFilter(session, { sessionId: 'other-999' })).toBe(false);
  });

  it('matches any session when no sessionId filter is set', () => {
    const loader = new MetricsDataLoader('/nonexistent');
    const session = rawSession('abc-123');
    expect(loader.sessionMatchesFilter(session, { agentName: 'claude' })).toBe(true);
  });
});
