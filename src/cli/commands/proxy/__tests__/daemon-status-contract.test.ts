/**
 * Daemon status / state / conflict contract.
 *
 * Pins the pure state-machine behavior of `daemon-manager.ts` (readState /
 * writeState / clearState / checkStatus / isProcessAlive), the strict
 * `daemonMatchesRequest` matcher from `connect-orchestrator.ts`, and the
 * `proxy status --json` "stopped" output shape — all WITHOUT spawning a real
 * daemon or touching the network. Live-daemon coverage lives in
 * tests/integration/proxy-daemon-lifecycle.test.ts; the mocked-spawn path lives
 * in ./daemon-manager.test.ts. This file deliberately does NOT re-assert those.
 *
 * @group unit
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readState,
  writeState,
  clearState,
  checkStatus,
  isProcessAlive,
  type DaemonState,
} from '../daemon-manager.js';
import {
  daemonMatchesRequest,
  getEffectiveClientType,
  type RequestedDaemonConfig,
} from '../connect-orchestrator.js';
import { createProxyCommand } from '../index.js';
import { getCodemieHome } from '../../../../utils/paths.js';

/** A fully-populated state, including every optional field, for round-trip fidelity. */
function makeFullState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    pid: process.pid,
    port: 4001,
    url: 'http://localhost:4001',
    profile: 'work',
    gatewayKey: 'codemie-proxy',
    telemetryMode: 'claude-desktop',
    targetUrl: 'https://upstream.example.com',
    provider: 'ai-run-sso',
    project: 'team-project',
    clientType: 'vscode-byok',
    syncApiUrl: 'https://api.example.com',
    syncCodeMieUrl: 'https://codemie.example.com',
    startedAt: new Date().toISOString(),
    health: 'ok',
    healthReason: undefined,
    recoveryAttempts: 0,
    ...overrides,
  };
}

// A PID that is (effectively) guaranteed never to be a live process.
const DEAD_PID = 999999;

describe('daemon-manager: state file round-trip (explicit stateFile in a temp dir)', () => {
  let dir: string;
  let stateFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codemie-daemon-state-'));
    stateFile = join(dir, 'proxy-daemon.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('write → read preserves every field, including all optional metadata', async () => {
    const state = makeFullState();
    await writeState(state, stateFile);

    const read = await readState(stateFile);
    // Full-fidelity: the persisted JSON must round-trip byte-equivalently.
    expect(read).toEqual(state);
    // Spot-check optional fields the minimal fixtures elsewhere never exercise.
    expect(read?.telemetryMode).toBe('claude-desktop');
    expect(read?.syncApiUrl).toBe('https://api.example.com');
    expect(read?.syncCodeMieUrl).toBe('https://codemie.example.com');
  });

  it('write → clear → read yields null (full lifecycle)', async () => {
    await writeState(makeFullState(), stateFile);
    expect(existsSync(stateFile)).toBe(true);

    await clearState(stateFile);
    expect(existsSync(stateFile)).toBe(false);
    expect(await readState(stateFile)).toBeNull();
  });

  it('readState returns null on malformed JSON rather than throwing', async () => {
    // Probe pins current contract: parse failure is swallowed → null.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(stateFile, '{ not valid json', 'utf-8');
    await expect(readState(stateFile)).resolves.toBeNull();
  });

  it('clearState is idempotent (second clear on a missing file does not throw)', async () => {
    await writeState(makeFullState(), stateFile);
    await clearState(stateFile);
    await expect(clearState(stateFile)).resolves.toBeUndefined();
  });
});

describe('daemon-manager: checkStatus', () => {
  let dir: string;
  let stateFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codemie-daemon-status-'));
    stateFile = join(dir, 'proxy-daemon.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports running=false and leaves no file when there is no state', async () => {
    const result = await checkStatus(stateFile);
    expect(result).toEqual({ running: false, state: null });
    expect(existsSync(stateFile)).toBe(false);
  });

  it('reports running=true and keeps the state file when the recorded PID is alive', async () => {
    await writeState(makeFullState({ pid: process.pid }), stateFile);

    const { running, state } = await checkStatus(stateFile);

    expect(running).toBe(true);
    expect(state?.pid).toBe(process.pid);
    // A live daemon's state file must survive the check.
    expect(existsSync(stateFile)).toBe(true);
  });

  it('reports running=false AND clears the stale state file when the PID is not alive', async () => {
    await writeState(makeFullState({ pid: DEAD_PID }), stateFile);
    expect(existsSync(stateFile)).toBe(true);

    const { running, state } = await checkStatus(stateFile);

    expect(running).toBe(false);
    expect(state).toBeNull();
    // Stale state must be garbage-collected on read.
    expect(existsSync(stateFile)).toBe(false);
  });
});

describe('daemon-manager: isProcessAlive', () => {
  it('is true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('is false for a definitely-dead PID', () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });
});

describe('connect-orchestrator: daemonMatchesRequest matrix', () => {
  const baseState: DaemonState = makeFullState({
    pid: 1234,
    clientType: 'vscode-byok',
    telemetryMode: undefined,
  });
  const request: RequestedDaemonConfig = {
    profile: 'work',
    port: 4001,
    project: 'team-project',
    clientType: 'vscode-byok',
    provider: 'ai-run-sso',
    targetUrl: 'https://upstream.example.com',
  };

  it('matches when every dimension is identical', () => {
    expect(daemonMatchesRequest(baseState, request)).toBe(true);
  });

  it('does not match on a different profile', () => {
    expect(daemonMatchesRequest({ ...baseState, profile: 'other' }, request)).toBe(false);
  });

  it('does not match on a different port', () => {
    expect(daemonMatchesRequest({ ...baseState, port: 5005 }, request)).toBe(false);
  });

  it('does not match on a different project', () => {
    expect(daemonMatchesRequest({ ...baseState, project: 'other' }, request)).toBe(false);
  });

  it('does not match on a different provider', () => {
    expect(daemonMatchesRequest({ ...baseState, provider: 'other-provider' }, request)).toBe(false);
  });

  it('does not match on a different targetUrl', () => {
    expect(daemonMatchesRequest({ ...baseState, targetUrl: 'https://elsewhere' }, request)).toBe(false);
  });

  it('does not match on a different effective client type', () => {
    expect(daemonMatchesRequest({ ...baseState, clientType: 'claude-desktop' }, request)).toBe(false);
  });

  it('ignores provider when the request omits it', () => {
    const req = { ...request, provider: undefined };
    expect(daemonMatchesRequest({ ...baseState, provider: 'anything' }, req)).toBe(true);
  });

  it('ignores targetUrl when the request omits it', () => {
    const req = { ...request, targetUrl: undefined };
    expect(daemonMatchesRequest({ ...baseState, targetUrl: 'https://anything' }, req)).toBe(true);
  });

  it('matches a legacy telemetry-mode daemon against a claude-desktop request', () => {
    // No explicit clientType → effective type derived from telemetryMode.
    const legacy = makeFullState({ clientType: undefined, telemetryMode: 'claude-desktop' });
    expect(getEffectiveClientType(legacy)).toBe('claude-desktop');
    expect(daemonMatchesRequest(legacy, { ...request, clientType: 'claude-desktop' })).toBe(true);
  });

  it('falls back to codemie-daemon effective type when neither clientType nor claude-desktop telemetry is set', () => {
    const generic = makeFullState({ clientType: undefined, telemetryMode: 'none' });
    expect(getEffectiveClientType(generic)).toBe('codemie-daemon');
    expect(daemonMatchesRequest(generic, { ...request, clientType: 'codemie-daemon' })).toBe(true);
  });
});

describe('proxy status --json: stopped shape (no live daemon)', () => {
  // The status action reads the DEFAULT state file under CODEMIE_HOME (an
  // isolated per-pid temp dir in the unit env). We guarantee absence up front so
  // checkStatus() resolves to "not running" and the stopped JSON branch is hit —
  // no socket, no health check, no network.
  const defaultStateFile = join(getCodemieHome(), 'proxy-daemon.json');
  const logSpy: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(async () => {
    await clearState(defaultStateFile);
    logSpy.length = 0;
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logSpy.push(args.map(String).join(' '));
    };
  });
  afterEach(async () => {
    console.log = originalLog;
    await clearState(defaultStateFile);
  });

  it('emits exactly {"status":"stopped"} as pretty JSON when nothing is running', async () => {
    const proxy = createProxyCommand();
    await proxy.parseAsync(['status', '--json'], { from: 'user' });

    expect(logSpy).toHaveLength(1);
    const parsed = JSON.parse(logSpy[0]);
    expect(parsed).toEqual({ status: 'stopped' });
    // No health-derived fields leak into the stopped payload.
    expect(parsed).not.toHaveProperty('url');
    expect(parsed).not.toHaveProperty('port');
    expect(parsed).not.toHaveProperty('level');
  });
});
