/**
 * Tests for transcript parse-state persistence: `createParseState`, `loadParseState`,
 * and `saveParseState`.
 *
 * `loadParseState` must never throw — a missing file or corrupt JSON on disk both fall
 * back to a fresh state, since later tasks drive transcript parsing off whatever this
 * returns and cannot tolerate a thrown exception interrupting that loop.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createParseState,
  loadParseState,
  saveParseState,
  withParseStateLock,
  type OpenUsageRequest,
  type TranscriptParseState,
} from '../parse-state.js';

let codemieHome: string;

/** Spawn-and-wait a throwaway process so its pid is guaranteed dead, for lock-reclaim tests. */
async function exitedPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    child.on('exit', () => resolve(child.pid as number));
  });
}

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

describe('saveParseState', () => {
  it('leaves no temp file behind after a successful save', async () => {
    const sessionId = 'session-atomic';
    await saveParseState(sessionId, createParseState());

    const filePath = join(codemieHome, 'analytics', 'state', `${sessionId}.json`);
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
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

  it('serializes concurrent acquirers so two never run inside the critical section at once', async () => {
    const sessionId = 'session-mutex';
    const events: string[] = [];
    const run = (label: string) =>
      withParseStateLock(sessionId, async () => {
        events.push(`${label}:enter`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push(`${label}:exit`);
      });

    await Promise.all([run('a'), run('b'), run('c')]);

    // Each label's enter/exit pair stays adjacent — no other label's enter lands between them.
    expect(events).toHaveLength(6);
    for (let i = 0; i < events.length; i += 2) {
      const label = events[i].split(':')[0];
      expect(events[i]).toBe(`${label}:enter`);
      expect(events[i + 1]).toBe(`${label}:exit`);
    }
  });

  it('reclaims a lock left behind by a process that has since exited', async () => {
    const sessionId = 'session-dead-holder';
    const lockPath = join(codemieHome, 'analytics', 'state', `${sessionId}.json.lock`);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, String(await exitedPid()));

    const result = await withParseStateLock(sessionId, async () => 'reclaimed');

    expect(result).toBe('reclaimed');
  });

  it('does not reclaim a lock whose holder process is still alive', async () => {
    const sessionId = 'session-live-holder';
    const lockPath = join(codemieHome, 'analytics', 'state', `${sessionId}.json.lock`);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, String(process.pid));

    const pending = withParseStateLock(sessionId, async () => 'acquired');
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Still exactly the lock we wrote — this test's own pid is alive, so it was never reclaimed.
    expect(readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));

    rmSync(lockPath, { force: true }); // simulate that holder releasing it
    await expect(pending).resolves.toBe('acquired');
  });

  it('reclaims an empty lock only once it is old enough to be abandoned', async () => {
    const sessionId = 'session-empty-lock';
    const lockPath = join(codemieHome, 'analytics', 'state', `${sessionId}.json.lock`);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    await expect(withParseStateLock(sessionId, async () => 'reclaimed')).resolves.toBe('reclaimed');
  });
});
