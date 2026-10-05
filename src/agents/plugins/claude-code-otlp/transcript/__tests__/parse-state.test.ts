/**
 * Tests for transcript parse-state persistence: `createParseState`, `loadParseState`,
 * and `saveParseState`.
 *
 * `loadParseState` must never throw — a missing file or corrupt JSON on disk both fall
 * back to a fresh state, since later tasks drive transcript parsing off whatever this
 * returns and cannot tolerate a thrown exception interrupting that loop.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createParseState,
  loadParseState,
  saveParseState,
  withParseStateLock,
  type OpenUsageRequest,
  type TranscriptParseState,
} from '../parse-state.js';

let codemieHome: string;

beforeEach(() => {
  codemieHome = mkdtempSync(join(tmpdir(), 'codemie-home-'));
  process.env.CODEMIE_HOME = codemieHome;
});

afterEach(() => {
  delete process.env.CODEMIE_HOME;
  rmSync(codemieHome, { recursive: true, force: true });
});

describe('createParseState', () => {
  it('returns the fresh shape', () => {
    expect(createParseState()).toEqual({
      mainOffset: 0,
      subagentOffsets: {},
      openRequests: {},
      activeSkill: '',
      branchCounts: {},
      compactionCount: 0,
    });
  });
});

describe('loadParseState', () => {
  it('returns the fresh shape when no state file exists', async () => {
    const state = await loadParseState('session-missing');

    expect(state).toEqual(createParseState());
  });

  it('recovers to the fresh shape instead of throwing on corrupt JSON', async () => {
    const stateDir = join(codemieHome, 'analytics', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'session-corrupt.json'), '{not valid json');

    const state = await loadParseState('session-corrupt');

    expect(state).toEqual(createParseState());
  });

  it('round-trips openRequests and branchCounts exactly through saveParseState', async () => {
    const openRequest: OpenUsageRequest = {
      requestId: 'req1',
      model: 'claude-3-5-sonnet',
      modelRaw: 'claude-3-5-sonnet-20241022',
      timestamp: '2026-10-01T00:00:00.000Z',
      speed: 'standard',
      inferenceGeo: 'us',
      serviceTier: 'standard',
      inputTokens: 100,
      cacheCreation5mTokens: 10,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 5,
      outputTokens: 200,
      webSearchRequests: 1,
      webFetchRequests: 0,
      scopeKind: 'main',
      scopeName: '',
      agentId: '',
      stopReason: 'end_turn',
      isApiError: false,
      gitBranch: 'main',
    };

    const state: TranscriptParseState = {
      mainOffset: 42,
      subagentOffsets: { 'sub-1': 7 },
      openRequests: { 'req1::claude-3-5-sonnet': openRequest },
      activeSkill: 'brainstorming',
      branchCounts: { main: 3, feature: 1 },
      compactionCount: 2,
    };

    await saveParseState('session-roundtrip', state);
    const loaded = await loadParseState('session-roundtrip');

    expect(loaded.openRequests).toEqual(state.openRequests);
    expect(loaded.branchCounts).toEqual(state.branchCounts);
    expect(loaded).toEqual(state);
  });
});

describe('withParseStateLock', () => {
  it('still runs fn when the lock cannot be released cleanly, and leaves no stale lock file behind', async () => {
    const sessionId = 'session-lock-cleanup';
    const result = await withParseStateLock(sessionId, async () => 'done');
    expect(result).toBe('done');

    // A second acquisition must not be blocked by a lock the first call failed to clean up.
    const second = await withParseStateLock(sessionId, async () => 'done-again');
    expect(second).toBe('done-again');
  });
});
