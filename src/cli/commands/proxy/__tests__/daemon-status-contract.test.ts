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
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readState,
  writeState,
  clearState,
  checkStatus,
  type DaemonState,
} from '../daemon-manager.js';
import { isProcessAlive, processStartedAt } from '../../../../utils/processes.js';
import {
  daemonMatchesRequest,
  type RequestedDaemonConfig,
} from '../connect-orchestrator.js';
import { createProxyCommand } from '../index.js';
import { getCodemieHome } from '../../../../utils/paths.js';
import { collectAnalyticsClients } from '../analytics-clients.js';

// The analytics clients block reads five fixed rows: no PATH lookup is spawned and no client file is read.
vi.mock('../analytics-clients.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../analytics-clients.js')>()),
  collectAnalyticsClients: vi.fn(async () => [
    { client: 'claude-code', label: 'Claude Code', found: true, connected: true, flag: '--claude-otlp', otherGateway: false },
    { client: 'vscode-claude-code', label: 'VS Code Claude Code extension', found: true, connected: true, flag: '--claude-otlp', otherGateway: false },
    { client: 'claude-desktop', label: 'Claude Desktop', found: true, connected: false, flag: '--claude-otlp', otherGateway: false },
    { client: 'copilot-chat', label: 'Copilot Chat', found: true, connected: false, flag: '--copilot-otlp', otherGateway: false },
    { client: 'copilot-cli', label: 'Copilot CLI', found: false, connected: false, flag: '--copilot-cli-otlp', otherGateway: false },
  ]),
}));
const ANALYTICS_CLIENT_LINES = [
  'Analytics clients:',
  '  Claude Code:                    connected',
  '  VS Code Claude Code extension:  connected',
  '  Claude Desktop:                 not connected — Run: codemie proxy connect --claude-otlp',
  '  Copilot Chat:                   not connected — Run: codemie proxy connect --copilot-otlp',
  '  Copilot CLI:                    not found — if it is installed, run: codemie proxy connect --copilot-cli-otlp',
];

/** A fully-populated state, including every optional field, for round-trip fidelity. */
function makeFullState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    pid: process.pid,
    port: 4001,
    url: 'http://localhost:4001',
    profile: 'work',
    gatewayKey: 'codemie-proxy',
    targetUrl: 'https://upstream.example.com',
    provider: 'ai-run-sso',
    project: 'team-project',
    syncApiUrl: 'https://api.example.com',
    syncCodeMieUrl: 'https://codemie.example.com',
    version: '0.17.0',
    desktopConnectedSince: '2026-11-16T10:00:00.000Z',
    startedAt: new Date(processStartedAt()).toISOString(),
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
    expect(read?.version).toBe('0.17.0');
    expect(read?.desktopConnectedSince).toBe('2026-11-16T10:00:00.000Z');
    expect(read?.syncApiUrl).toBe('https://api.example.com');
    expect(read?.syncCodeMieUrl).toBe('https://codemie.example.com');
  });

  it('reads a state file that still holds telemetryMode and clientType with no error', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(stateFile, JSON.stringify({
      ...makeFullState(),
      telemetryMode: 'claude-desktop',
      clientType: 'codemie-daemon',
    }), 'utf-8');

    await expect(readState(stateFile)).resolves.toMatchObject({ pid: process.pid, version: '0.17.0' });
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
  const baseState: DaemonState = makeFullState({ pid: 1234 });
  const request: RequestedDaemonConfig = {
    profile: 'work',
    port: 4001,
    project: 'team-project',
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

  it('ignores provider when the request omits it', () => {
    const req = { ...request, provider: undefined };
    expect(daemonMatchesRequest({ ...baseState, provider: 'anything' }, req)).toBe(true);
  });

  it('ignores targetUrl when the request omits it', () => {
    const req = { ...request, targetUrl: undefined };
    expect(daemonMatchesRequest({ ...baseState, targetUrl: 'https://anything' }, req)).toBe(true);
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

  it('emits exactly the stopped status and the analytics clients as pretty JSON when nothing is running', async () => {
    const proxy = createProxyCommand();
    await proxy.parseAsync(['status', '--json'], { from: 'user' });

    expect(logSpy).toHaveLength(1);
    const parsed = JSON.parse(logSpy[0]);
    expect(parsed).toEqual({
      status: 'stopped',
      analyticsClients: [
        { client: 'claude-code', found: true, connected: true, flag: '--claude-otlp' },
        { client: 'vscode-claude-code', found: true, connected: true, flag: '--claude-otlp' },
        { client: 'claude-desktop', found: true, connected: false, flag: '--claude-otlp' },
        { client: 'copilot-chat', found: true, connected: false, flag: '--copilot-otlp' },
        { client: 'copilot-cli', found: false, connected: false, flag: '--copilot-cli-otlp' },
      ],
    });
    expect(collectAnalyticsClients).toHaveBeenLastCalledWith(null);
    // No health-derived fields leak into the stopped payload.
    expect(parsed).not.toHaveProperty('url');
    expect(parsed).not.toHaveProperty('port');
    expect(parsed).not.toHaveProperty('level');
    expect(parsed).not.toHaveProperty('analytics');
  });

  it('prints only "Status: stopped" and the analytics clients in text mode, with no Analytics line', async () => {
    const proxy = createProxyCommand();
    await proxy.parseAsync(['status'], { from: 'user' });

    expect(logSpy).toEqual(['Status: stopped', ...ANALYTICS_CLIENT_LINES]);
    expect(collectAnalyticsClients).toHaveBeenLastCalledWith(null);
  });

  it('reads the state of a dead daemon as stopped and leaves its file byte-identical', async () => {
    const content = JSON.stringify(makeFullState({ pid: DEAD_PID }), null, 2);
    const { mkdir, writeFile, readFile } = await import('node:fs/promises');
    await mkdir(getCodemieHome(), { recursive: true });
    await writeFile(defaultStateFile, content, 'utf-8');

    const proxy = createProxyCommand();
    await proxy.parseAsync(['status'], { from: 'user' });

    expect(logSpy).toEqual(['Status: stopped', ...ANALYTICS_CLIENT_LINES]);
    expect(await readFile(defaultStateFile, 'utf-8')).toBe(content);
  });
});
