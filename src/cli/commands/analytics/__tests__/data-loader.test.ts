/**
 * Unit tests for MetricsDataLoader's session-id filtering — regression coverage for
 * the bug where `--session <id>` silently matched every session.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

describe('MetricsDataLoader.loadSessions — completed_ prefixed sessions', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'data-loader-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCompletedSession(id: string): void {
    writeFileSync(
      join(dir, `completed_${id}.json`),
      JSON.stringify({
        startTime: 1000,
        endTime: 2000,
        status: 'completed',
        agentName: 'claude',
        provider: 'anthropic',
        workingDirectory: '/tmp/project',
      })
    );
  }

  it('derives the bare UUID (not "completed_<uuid>") as sessionId', () => {
    const sessionId = 'eddd66b2-0e73-4167-841c-9263207870ae';
    writeCompletedSession(sessionId);

    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(sessionId);
  });

  it('filters to exactly the requested completed session by bare UUID', () => {
    const target = 'eddd66b2-0e73-4167-841c-9263207870ae';
    const other = '086cca74-d58d-4007-a529-fa73910c085e';
    writeCompletedSession(target);
    writeCompletedSession(other);

    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions({ sessionId: target });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(target);
  });

  it('still reads deltas from the completed_-prefixed metrics file', () => {
    const sessionId = 'eddd66b2-0e73-4167-841c-9263207870ae';
    writeCompletedSession(sessionId);
    const delta = { recordId: 'd1', sessionId, syncStatus: 'synced', gitBranch: 'main' };
    writeFileSync(join(dir, `completed_${sessionId}_metrics.jsonl`), JSON.stringify(delta) + '\n');

    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions({ sessionId });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].deltas).toHaveLength(1);
  });

  it('does not double-count a session when both the active and completed_ filenames exist for the same id', () => {
    const sessionId = 'eddd66b2-0e73-4167-841c-9263207870ae';
    // Simulate an interrupted/non-atomic hook.ts rename: both filenames present at once.
    writeFileSync(
      join(dir, `${sessionId}.json`),
      JSON.stringify({
        startTime: 1000,
        agentName: 'claude',
        provider: 'anthropic',
        workingDirectory: '/tmp/project',
      })
    );
    writeCompletedSession(sessionId);

    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(sessionId);
  });

  it('returns null and skips the session when neither filename variant exists', () => {
    const loader = new MetricsDataLoader(dir);
    // Filter targets an id with no backing file at all.
    const sessions = loader.loadSessions({ sessionId: 'no-such-session' });

    expect(sessions).toHaveLength(0);
  });

  it('resolves the .json and _metrics.jsonl suffixes independently when only one has been renamed', () => {
    const sessionId = 'eddd66b2-0e73-4167-841c-9263207870ae';
    // Active metadata file, but the metrics file was already renamed to completed_ (partial rename).
    writeFileSync(
      join(dir, `${sessionId}.json`),
      JSON.stringify({
        startTime: 1000,
        agentName: 'claude',
        provider: 'anthropic',
        workingDirectory: '/tmp/project',
      })
    );
    const delta = { recordId: 'd1', sessionId, syncStatus: 'synced', gitBranch: 'main' };
    writeFileSync(join(dir, `completed_${sessionId}_metrics.jsonl`), JSON.stringify(delta) + '\n');

    const loader = new MetricsDataLoader(dir);
    const sessions = loader.loadSessions({ sessionId });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].deltas).toHaveLength(1);
  });
});
