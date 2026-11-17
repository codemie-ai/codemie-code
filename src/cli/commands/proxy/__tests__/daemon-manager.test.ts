/**
 * DaemonManager state file utilities tests
 * @group unit
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { writeFile, readFile, readdir, unlink, mkdir, rm, rmdir } from 'fs/promises';
import { existsSync } from 'fs';
import { createServer } from 'http';
import type { AddressInfo } from 'net';

// Override state file path before importing
const TEST_STATE_FILE = join(tmpdir(), `codemie-proxy-daemon-test-${Date.now()}.json`);
const DEFAULT_TEST_STATE_FILE = join(tmpdir(), 'proxy-daemon.json');
const DEFAULT_TEST_CONNECTION_FILE = join(tmpdir(), 'proxy-connection.json');
vi.mock('../../../../utils/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/paths.js')>();
  return {
    ...actual,
    getCodemieHome: () => tmpdir(),
    getCodemiePath: (...p: string[]) => join(tmpdir(), ...p),
    getDirname: () => tmpdir(),
    resolveHomeDir: (p: string) => p,
  };
});

vi.mock('../../../../utils/processes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/processes.js')>();
  return {
    ...actual,
    spawnDetached: vi.fn(),
    // The start comparison runs `ps`; tests that exercise it switch this to the real one with `ps` mocked
    isOwnerAlive: vi.fn(async () => true),
  };
});

import * as exec from '../../../../utils/exec.js';
import { isOwnerAlive, isProcessAlive, processStartedAt, spawnDetached } from '../../../../utils/processes.js';
import { logger } from '../../../../utils/logger.js';

import {
  readState,
  writeState,
  clearState,
  checkStatus,
  daemonStartedAt,
  isDaemonAlive,
  spawnDaemon,
  stopDaemon,
  readConnectionRecord,
  readDaemonStatus,
  writeConnectionRecord,
  writeConnectionPort,
  clearLegacyClientIdentity,
  hasLegacyClientIdentity,
  seedConnectionRecord,
  type DaemonState,
} from '../daemon-manager.js';
import { SHALLOW_TIMEOUT_MS } from '../health-check.js';

/** What `/health` answers per port; a port missing here refuses the connection, as no proxy listens on it. */
const healthAnswers = new Map<number, unknown>();
const healthRequests: string[] = [];
const realFetch = globalThis.fetch;
// Never a real request: a proxy on this machine (the user's daemon on 4001) must not answer a test
vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
  healthRequests.push(String(url));
  const port = Number(new URL(String(url)).port);
  if (!healthAnswers.has(port)) throw new TypeError('fetch failed: ECONNREFUSED');
  return new Response(JSON.stringify(healthAnswers.get(port)), { status: 200, headers: { 'content-type': 'application/json' } });
}));

const actualProcesses = await vi.importActual<typeof import('../../../../utils/processes.js')>('../../../../utils/processes.js');

const HOST_PLATFORM = process.platform;

/** `isDaemonAlive` runs the start check only off Windows: tests of that check pin the platform. */
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value });
}

function killError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const SAMPLE_STATE: DaemonState = {
  pid: process.pid,
  port: 4001,
  url: 'http://localhost:4001',
  profile: 'default',
  gatewayKey: 'codemie-proxy',
  startedAt: new Date(processStartedAt()).toISOString(),
};

describe('readState', () => {
  afterEach(async () => { try { await unlink(TEST_STATE_FILE); } catch { /* ignore */ } });

  it('returns null when state file does not exist', async () => {
    expect(await readState(TEST_STATE_FILE)).toBeNull();
  });

  it('returns parsed state when file exists', async () => {
    await writeFile(TEST_STATE_FILE, JSON.stringify(SAMPLE_STATE), 'utf-8');
    const state = await readState(TEST_STATE_FILE);
    expect(state?.pid).toBe(SAMPLE_STATE.pid);
    expect(state?.url).toBe(SAMPLE_STATE.url);
  });

  it('reads daemon state files without optional client metadata', async () => {
    await writeFile(TEST_STATE_FILE, JSON.stringify(SAMPLE_STATE), 'utf-8');

    const state = await readState(TEST_STATE_FILE);

    expect(state).toMatchObject(SAMPLE_STATE);
    expect(state?.clientType).toBeUndefined();
  });
});

describe('writeState', () => {
  afterEach(async () => { try { await unlink(TEST_STATE_FILE); } catch { /* ignore */ } });

  it('writes state atomically (file is readable immediately after)', async () => {
    await writeState(SAMPLE_STATE, TEST_STATE_FILE);
    expect(existsSync(TEST_STATE_FILE)).toBe(true);
    const state = await readState(TEST_STATE_FILE);
    expect(state?.port).toBe(4001);
  });

  it('does not leave a .tmp file behind', async () => {
    await writeState(SAMPLE_STATE, TEST_STATE_FILE);
    expect(existsSync(`${TEST_STATE_FILE}.${process.pid}.tmp`)).toBe(false);
  });

  it('writes through a temp file named by its own pid', async () => {
    // A directory in the way of the per-process temp name: only a writer that uses it fails
    const tmp = `${TEST_STATE_FILE}.${process.pid}.tmp`;
    await mkdir(tmp);
    try {
      await expect(writeState(SAMPLE_STATE, TEST_STATE_FILE)).rejects.toThrow(tmp);
    } finally {
      await rmdir(tmp);
    }
  });
});

describe('clearState', () => {
  it('removes the state file if it exists', async () => {
    await writeFile(TEST_STATE_FILE, '{}', 'utf-8');
    await clearState(TEST_STATE_FILE);
    expect(existsSync(TEST_STATE_FILE)).toBe(false);
  });

  it('does not throw when file does not exist', async () => {
    await expect(clearState(TEST_STATE_FILE)).resolves.not.toThrow();
  });
});

describe('isProcessAlive', () => {
  it('returns true for current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for non-existent PID', () => {
    expect(isProcessAlive(9999999)).toBe(false);
  });
});

describe('daemonStartedAt', () => {
  it('is the start of the daemon process, not the moment the state is written', () => {
    const processStart = Date.now() - process.uptime() * 1000;
    expect(Math.abs(Date.parse(daemonStartedAt()) - processStart)).toBeLessThanOrEqual(50);
  });
});

describe('checkStatus', () => {
  afterEach(async () => {
    setPlatform(HOST_PLATFORM);
    vi.restoreAllMocks();
    vi.mocked(isOwnerAlive).mockImplementation(async () => true);
    try { await unlink(TEST_STATE_FILE); } catch { /* ignore */ }
  });

  it('returns running=false when no state file', async () => {
    const { running } = await checkStatus(TEST_STATE_FILE);
    expect(running).toBe(false);
  });

  it.each([
    ['an empty', ''],
    ['an unparsable', '{'],
  ])('reads %s state file as no daemon at a start and leaves the file in place', async (_label, content) => {
    await writeFile(TEST_STATE_FILE, content, 'utf-8');

    expect(await readState(TEST_STATE_FILE)).toBeNull();
    expect(await checkStatus(TEST_STATE_FILE)).toEqual({ running: false, state: null });
    expect(await readFile(TEST_STATE_FILE, 'utf-8')).toBe(content);
  });

  it('returns running=true when state file has alive PID', async () => {
    await writeState({ ...SAMPLE_STATE, pid: process.pid }, TEST_STATE_FILE);
    const { running, state } = await checkStatus(TEST_STATE_FILE);
    expect(running).toBe(true);
    expect(state?.pid).toBe(process.pid);
    expect(existsSync(TEST_STATE_FILE)).toBe(true);
  });

  it('returns running=false and cleans stale state when PID is dead', async () => {
    await writeState({ ...SAMPLE_STATE, pid: 9999999 }, TEST_STATE_FILE);
    const { running } = await checkStatus(TEST_STATE_FILE);
    expect(running).toBe(false);
    expect(existsSync(TEST_STATE_FILE)).toBe(false);
  });

  it.each(['EPERM', 'ESRCH'])('returns running=false and cleans the state when kill(pid, 0) fails with %s', async (code) => {
    await writeState({ ...SAMPLE_STATE, pid: 4242 }, TEST_STATE_FILE);
    vi.spyOn(process, 'kill').mockImplementation(() => { throw killError(code); });

    expect(await checkStatus(TEST_STATE_FILE)).toEqual({ running: false, state: null });
    expect(existsSync(TEST_STATE_FILE)).toBe(false);
  });

  it('returns running=false and cleans the state when the live pid fails the start check', async () => {
    setPlatform('linux');
    await writeState({ ...SAMPLE_STATE, pid: 4242 }, TEST_STATE_FILE);
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.mocked(isOwnerAlive).mockResolvedValue(false);

    expect(await checkStatus(TEST_STATE_FILE)).toEqual({ running: false, state: null });
    expect(existsSync(TEST_STATE_FILE)).toBe(false);
  });

  it('returns running=true when the live pid passes the start check', async () => {
    setPlatform('linux');
    await writeState({ ...SAMPLE_STATE, pid: 4242 }, TEST_STATE_FILE);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect((await checkStatus(TEST_STATE_FILE)).running).toBe(true);
    expect(existsSync(TEST_STATE_FILE)).toBe(true);
  });

  describe('on Windows', () => {
    beforeEach(() => {
      setPlatform('win32');
      // A start check that ran would read the daemon gone
      vi.mocked(isOwnerAlive).mockResolvedValue(false);
    });

    it('returns running=true from the pid check alone, without the start check', async () => {
      await writeState({ ...SAMPLE_STATE, pid: 4242 }, TEST_STATE_FILE);
      vi.spyOn(process, 'kill').mockImplementation(() => true);

      expect((await checkStatus(TEST_STATE_FILE)).running).toBe(true);
      expect(existsSync(TEST_STATE_FILE)).toBe(true);
    });

    it('returns running=false when kill(pid, 0) fails with EPERM', async () => {
      await writeState({ ...SAMPLE_STATE, pid: 4242 }, TEST_STATE_FILE);
      vi.spyOn(process, 'kill').mockImplementation(() => { throw killError('EPERM'); });

      expect(await checkStatus(TEST_STATE_FILE)).toEqual({ running: false, state: null });
      expect(existsSync(TEST_STATE_FILE)).toBe(false);
    });
  });

  describe('the start comparison', () => {
    const NOW = Date.parse('2026-10-31T12:00:00Z');
    const originalPlatform = process.platform;
    let ps: ReturnType<typeof vi.spyOn>;

    /** `ps` reports the live pid running for `etime`: its real start is NOW minus that. */
    function psReports(etime: string): void {
      ps.mockResolvedValue({ code: 0, stdout: `${etime}\n`, stderr: '' });
    }

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      vi.spyOn(process, 'kill').mockImplementation(() => true);
      ps = vi.spyOn(exec, 'exec');
      vi.mocked(isOwnerAlive).mockImplementation(actualProcesses.isOwnerAlive);
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('returns running=false and cleans the state when the live pid started over 60 s after the recorded start', async () => {
      // A reused pid: its process started 2 minutes after the daemon recorded its own start
      psReports('05:00');
      await writeState({ ...SAMPLE_STATE, pid: 4242, startedAt: new Date(NOW - 420_000).toISOString() }, TEST_STATE_FILE);

      expect(await checkStatus(TEST_STATE_FILE)).toEqual({ running: false, state: null });
      expect(existsSync(TEST_STATE_FILE)).toBe(false);
    });

    it('returns running=true for an old-format state written 10 minutes after the daemon started', async () => {
      psReports('20:00');
      await writeState({ ...SAMPLE_STATE, pid: 4242, startedAt: new Date(NOW - 600_000).toISOString() }, TEST_STATE_FILE);

      expect((await checkStatus(TEST_STATE_FILE)).running).toBe(true);
      expect(existsSync(TEST_STATE_FILE)).toBe(true);
    });

    it('returns running=true after a backward wall-clock step puts the real start 2 minutes before the recorded one', async () => {
      psReports('05:00');
      await writeState({ ...SAMPLE_STATE, pid: 4242, startedAt: new Date(NOW - 180_000).toISOString() }, TEST_STATE_FILE);

      expect((await checkStatus(TEST_STATE_FILE)).running).toBe(true);
    });

    it('judges a state without a start time by its pid alone', async () => {
      ps.mockRejectedValue(new Error('ps must not run without a start time'));
      const { startedAt: _omitted, ...withoutStart } = SAMPLE_STATE;
      await writeState({ ...withoutStart, pid: 4242 } as DaemonState, TEST_STATE_FILE);
      expect((await checkStatus(TEST_STATE_FILE)).running).toBe(true);
      expect(existsSync(TEST_STATE_FILE)).toBe(true);
    });
  });
});

describe('readDaemonStatus', () => {
  afterEach(async () => { try { await unlink(TEST_STATE_FILE); } catch { /* ignore */ } });

  it('reads the state of a dead daemon as stopped and leaves its file byte-identical', async () => {
    const content = JSON.stringify({ ...SAMPLE_STATE, pid: 9999999 }, null, 2);
    await writeFile(TEST_STATE_FILE, content, 'utf-8');

    expect(await readDaemonStatus(TEST_STATE_FILE)).toEqual({ running: false, state: null });
    expect(await readFile(TEST_STATE_FILE, 'utf-8')).toBe(content);
  });

  it('reads a live daemon as running with its state', async () => {
    await writeState(SAMPLE_STATE, TEST_STATE_FILE);

    expect(await readDaemonStatus(TEST_STATE_FILE)).toEqual({ running: true, state: SAMPLE_STATE });
  });
});

describe('stopDaemon', () => {
  afterEach(async () => {
    setPlatform(HOST_PLATFORM);
    vi.restoreAllMocks();
    try { await unlink(DEFAULT_TEST_STATE_FILE); } catch { /* ignore */ }
  });

  it('clears the state without throwing when its pid now belongs to another user', async () => {
    await writeState({ ...SAMPLE_STATE, pid: 4242 }, DEFAULT_TEST_STATE_FILE);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });

    await expect(stopDaemon()).resolves.toBeUndefined();

    expect(existsSync(DEFAULT_TEST_STATE_FILE)).toBe(false);
  });

  it('confirms the daemon once, then waits on its pid alone and sends SIGKILL after 5 s of SIGTERM', async () => {
    setPlatform('linux');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await writeState({ ...SAMPLE_STATE, pid: 4242 }, DEFAULT_TEST_STATE_FILE);
    // The start check holds only once: a wait loop that re-ran it would read the daemon gone and never escalate
    vi.mocked(isOwnerAlive).mockResolvedValueOnce(true).mockResolvedValue(false);
    const signals: Array<string | number | undefined> = [];
    let killed = false;
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        signals.push(signal);
        killed = signal === 'SIGKILL';
        return true;
      }
      if (killed) throw killError('ESRCH');
      return true;
    });

    try {
      let done = false;
      const stopping = stopDaemon().finally(() => { done = true; });
      while (!done) {
        await vi.advanceTimersByTimeAsync(100);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      await stopping;
    } finally {
      vi.useRealTimers();
      vi.mocked(isOwnerAlive).mockImplementation(async () => true);
    }

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(existsSync(DEFAULT_TEST_STATE_FILE)).toBe(false);
  });
});

describe('a live pid that fails the start check', () => {
  const PORT = 47123;

  beforeEach(() => {
    setPlatform('linux');
    healthAnswers.clear();
    healthRequests.length = 0;
    vi.mocked(isOwnerAlive).mockResolvedValue(false);
  });

  afterEach(async () => {
    setPlatform(HOST_PLATFORM);
    vi.restoreAllMocks();
    vi.mocked(isOwnerAlive).mockImplementation(async () => true);
    healthAnswers.clear();
    for (const file of [TEST_STATE_FILE, DEFAULT_TEST_STATE_FILE]) {
      try { await unlink(file); } catch { /* ignore */ }
    }
  });

  /** The pid runs until SIGTERM / SIGKILL; the signals sent are collected. */
  function livePidUntilSignalled(): string[] {
    const signals: string[] = [];
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        signals.push(signal);
        return true;
      }
      if (signals.length > 0) throw killError('ESRCH');
      return true;
    });
    return signals;
  }

  it('reads running and stops with SIGTERM when the proxy answers /health on the state\'s port', async () => {
    healthAnswers.set(PORT, { status: 'ok', port: PORT, startedAt: SAMPLE_STATE.startedAt, pid: 4242 });
    const signals = livePidUntilSignalled();
    await writeState({ ...SAMPLE_STATE, pid: 4242, port: PORT }, TEST_STATE_FILE);

    expect((await checkStatus(TEST_STATE_FILE)).running).toBe(true);
    expect(existsSync(TEST_STATE_FILE)).toBe(true);

    await writeState({ ...SAMPLE_STATE, pid: 4242, port: PORT }, DEFAULT_TEST_STATE_FILE);
    await stopDaemon();
    expect(signals).toEqual(['SIGTERM']);
    expect(existsSync(DEFAULT_TEST_STATE_FILE)).toBe(false);
  });

  it('reads not running, clears the state and sends no signal when nothing answers on the state\'s port', async () => {
    const signals = livePidUntilSignalled();
    await writeState({ ...SAMPLE_STATE, pid: 4242, port: PORT }, TEST_STATE_FILE);

    expect(await checkStatus(TEST_STATE_FILE)).toEqual({ running: false, state: null });
    expect(existsSync(TEST_STATE_FILE)).toBe(false);

    await writeState({ ...SAMPLE_STATE, pid: 4242, port: PORT }, DEFAULT_TEST_STATE_FILE);
    await stopDaemon();
    expect(signals).toEqual([]);
    expect(existsSync(DEFAULT_TEST_STATE_FILE)).toBe(false);
  });

  it('reads not running when the proxy on the state\'s port reports another port', async () => {
    healthAnswers.set(PORT, { status: 'ok', port: PORT + 1 });
    livePidUntilSignalled();
    await writeState({ ...SAMPLE_STATE, pid: 4242, port: PORT }, TEST_STATE_FILE);

    expect(await checkStatus(TEST_STATE_FILE)).toEqual({ running: false, state: null });
    expect(existsSync(TEST_STATE_FILE)).toBe(false);
  });

  it('reads not running and sends no signal when the proxy on the state\'s port reports another pid', async () => {
    healthAnswers.set(PORT, { status: 'ok', port: PORT, startedAt: SAMPLE_STATE.startedAt, pid: 4243 });
    const signals = livePidUntilSignalled();
    await writeState({ ...SAMPLE_STATE, pid: 4242, port: PORT }, TEST_STATE_FILE);

    expect(await checkStatus(TEST_STATE_FILE)).toEqual({ running: false, state: null });
    expect(existsSync(TEST_STATE_FILE)).toBe(false);

    await writeState({ ...SAMPLE_STATE, pid: 4242, port: PORT }, DEFAULT_TEST_STATE_FILE);
    await stopDaemon();
    expect(signals).toEqual([]);
  });

  it('makes no health request when the start check passes', async () => {
    vi.mocked(isOwnerAlive).mockResolvedValue(true);
    livePidUntilSignalled();
    await writeState({ ...SAMPLE_STATE, pid: 4242, port: PORT }, TEST_STATE_FILE);

    expect((await checkStatus(TEST_STATE_FILE)).running).toBe(true);
    expect(healthRequests).toEqual([]);
  });

  it('reads not running within the shallow deadline when the /health body stalls after the headers', async () => {
    const stub = globalThis.fetch;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      vi.stubGlobal('fetch', realFetch);
      livePidUntilSignalled();

      expect(await isDaemonAlive({ ...SAMPLE_STATE, pid: 4242, port })).toBe(false);
    } finally {
      vi.stubGlobal('fetch', stub);
      server.closeAllConnections();
      server.close();
    }
  }, SHALLOW_TIMEOUT_MS + 1_000);
});

describe('spawnDaemon', () => {
  afterEach(async () => {
    vi.clearAllMocks();
    try { await unlink(DEFAULT_TEST_STATE_FILE); } catch { /* ignore */ }
    try { await unlink(DEFAULT_TEST_CONNECTION_FILE); } catch { /* ignore */ }
  });

  function arrangeReadyDaemon(): void {
    vi.mocked(spawnDetached).mockImplementation(() => {
      void writeFile(DEFAULT_TEST_STATE_FILE, JSON.stringify(SAMPLE_STATE), 'utf-8');
      return SAMPLE_STATE.pid;
    });
  }

  it('passes the project and no client identity, without model arguments', async () => {
    arrangeReadyDaemon();

    await spawnDaemon({
      targetUrl: 'https://upstream.example.com',
      provider: 'ai-run-sso',
      profile: 'work',
      port: 4001,
      project: 'team-project',
    });

    const args = vi.mocked(spawnDetached).mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining(['--project', 'team-project']));
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--client-type');
    expect(args).not.toContain('--telemetry-mode');
  });

  it('turns the start values into the daemon arguments one for one, the shared gateway key by default', async () => {
    arrangeReadyDaemon();

    await spawnDaemon({
      targetUrl: 'https://t',
      provider: 'ai-run-sso',
      profile: 'p',
      port: 4001,
      model: 'm1',
      project: 'A',
      projectBinding: 'own',
      syncApiUrl: 'https://s',
      syncCodeMieUrl: 'https://c',
    });

    expect(vi.mocked(spawnDetached).mock.calls[0][1].slice(1)).toEqual([
      '--target-url', 'https://t',
      '--provider', 'ai-run-sso',
      '--profile', 'p',
      '--gateway-key', 'codemie-proxy',
      '--model', 'm1',
      '--project', 'A',
      '--project-binding', 'own',
      '--state-file', DEFAULT_TEST_STATE_FILE,
      '--port', '4001',
      '--sync-api-url', 'https://s',
      '--sync-codemie-url', 'https://c',
    ]);
  });

  it('ignores a live state of another pid and returns the state its own child writes', async () => {
    const other: DaemonState = { ...SAMPLE_STATE, pid: process.ppid, port: 4002 };
    vi.mocked(spawnDetached).mockImplementation(() => {
      void writeFile(DEFAULT_TEST_STATE_FILE, JSON.stringify(other), 'utf-8');
      // The child is slow to start: its own state lands a few polls after the other daemon's.
      setTimeout(() => { void writeFile(DEFAULT_TEST_STATE_FILE, JSON.stringify(SAMPLE_STATE), 'utf-8'); }, 400);
      return SAMPLE_STATE.pid;
    });

    const state = await spawnDaemon({ targetUrl: 'https://t', provider: 'ai-run-sso', profile: 'default', port: 4001 });

    expect(state).toMatchObject({ pid: SAMPLE_STATE.pid, port: 4001 });
  });

  describe('a child that writes no state of its own within the ready wait', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    async function spawnUntilSettled(): Promise<unknown> {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      let outcome: unknown;
      let done = false;
      const spawning = spawnDaemon({ targetUrl: 'https://t', provider: 'ai-run-sso', profile: 'default', port: 4001 })
        .then(() => { outcome = 'resolved'; }, (error: unknown) => { outcome = error; })
        .finally(() => { done = true; });
      while (!done) {
        await vi.advanceTimersByTimeAsync(100);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      await spawning;
      return outcome;
    }

    it.each([
      ['a child that died before writing it', 9999999],
      ['a failed spawn', -1],
    ])('%s ends in the timeout error and no signal is sent to it', async (_label, pid) => {
      const signals: Array<string | number | undefined> = [];
      vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
        if (signal !== undefined && signal !== 0) signals.push(signal);
        return true;
      });
      vi.mocked(spawnDetached).mockImplementation(() => pid);

      const outcome = await spawnUntilSettled();

      expect(String(outcome)).toContain('Daemon failed to start within 5 seconds');
      expect(signals).toEqual([]);
    });

    it('a live state of another daemon is not taken for the child', async () => {
      await writeFile(DEFAULT_TEST_STATE_FILE, JSON.stringify({ ...SAMPLE_STATE, pid: process.ppid }), 'utf-8');
      vi.mocked(spawnDetached).mockImplementation(() => SAMPLE_STATE.pid);

      expect(String(await spawnUntilSettled())).toContain('Daemon failed to start within 5 seconds');
    });
  });

  it('forwards the profile model as a --model argument when set', async () => {
    arrangeReadyDaemon();

    await spawnDaemon({
      targetUrl: 'https://upstream.example.com',
      provider: 'ai-run-sso',
      profile: 'work',
      port: 4001,
      model: 'gpt-5.6-luna-2026-07-09',
    });

    const args = vi.mocked(spawnDetached).mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-5.6-luna-2026-07-09']));
  });

  it('omits optional context when it is not configured', async () => {
    arrangeReadyDaemon();

    await spawnDaemon({
      targetUrl: 'https://upstream.example.com',
      provider: 'ai-run-sso',
      profile: 'work',
      port: 4001,
    });

    const args = vi.mocked(spawnDetached).mock.calls[0][1];
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--project');
  });

  it('keeps the gateway key out of every log call', async () => {
    arrangeReadyDaemon();
    const gatewayKey = 'gw-key-must-not-be-logged';
    const logged = [
      vi.spyOn(logger, 'debug'),
      vi.spyOn(logger, 'info'),
      vi.spyOn(logger, 'warn'),
    ].map((spy) => spy.mockImplementation(() => undefined));

    await spawnDaemon({
      targetUrl: 'https://upstream.example.com',
      provider: 'ai-run-sso',
      profile: 'work',
      port: 4001,
      gatewayKey,
    });

    expect(vi.mocked(spawnDetached).mock.calls[0][1]).toEqual(expect.arrayContaining(['--gateway-key', gatewayKey]));
    expect(logged[0]).toHaveBeenCalledWith('[daemon-manager] Spawning daemon', expect.anything());
    expect(JSON.stringify(logged.flatMap((spy) => spy.mock.calls))).not.toContain(gatewayKey);
  });

  describe('connection record', () => {
    const WORK_STATE: DaemonState = {
      ...SAMPLE_STATE,
      profile: 'work',
      project: 'team-project',
      clientType: 'codemie-claude',
    };
    const WORK_SPAWN = {
      targetUrl: 'https://upstream.example.com',
      provider: 'ai-run-sso',
      profile: 'work',
      port: 4001,
      project: 'team-project',
    };

    function arrangeDaemonState(state: DaemonState): void {
      vi.mocked(spawnDetached).mockImplementation(() => {
        void writeFile(DEFAULT_TEST_STATE_FILE, JSON.stringify(state), 'utf-8');
        return state.pid;
      });
    }

    afterEach(async () => {
      try { await unlink(DEFAULT_TEST_CONNECTION_FILE); } catch { /* ignore */ }
      try { await rm(DEFAULT_TEST_CONNECTION_FILE, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('records the profile, and with no record the port it asked for, once the daemon runs on it', async () => {
      arrangeDaemonState(WORK_STATE);

      await spawnDaemon(WORK_SPAWN);

      const record = JSON.parse(await readFile(DEFAULT_TEST_CONNECTION_FILE, 'utf-8'));
      expect(record).toMatchObject({ profile: 'work', port: 4001 });
      expect(record).not.toHaveProperty('clientType');
      expect(record).not.toHaveProperty('telemetryMode');
    });

    it('records no port when the daemon came up on another port than it asked for', async () => {
      arrangeDaemonState({ ...WORK_STATE, port: 60122 });

      await spawnDaemon(WORK_SPAWN);

      const record = JSON.parse(await readFile(DEFAULT_TEST_CONNECTION_FILE, 'utf-8'));
      expect(record.profile).toBe('work');
      expect(record).not.toHaveProperty('port');
    });

    it('keeps the recorded port when the record has one', async () => {
      await writeFile(DEFAULT_TEST_CONNECTION_FILE, JSON.stringify({ version: 1, profile: 'work', port: 52311 }), 'utf-8');
      arrangeDaemonState(WORK_STATE);

      await spawnDaemon(WORK_SPAWN);

      expect(JSON.parse(await readFile(DEFAULT_TEST_CONNECTION_FILE, 'utf-8')).port).toBe(52311);
    });

    it('without writeRecord sets only the port of a record that has none', async () => {
      const existing = { version: 1, profile: 'recorded', clientType: 'codex-desktop', updatedAt: 'x' };
      await writeFile(DEFAULT_TEST_CONNECTION_FILE, JSON.stringify(existing), 'utf-8');
      arrangeDaemonState(WORK_STATE);

      await spawnDaemon({ ...WORK_SPAWN, writeRecord: false });

      expect(JSON.parse(await readFile(DEFAULT_TEST_CONNECTION_FILE, 'utf-8'))).toEqual({ ...existing, port: 4001 });
    });

    it('with writeRecord and recordPort false leaves a record without port as it is', async () => {
      const existing = { version: 1, profile: 'recorded', updatedAt: 'x' };
      await writeFile(DEFAULT_TEST_CONNECTION_FILE, JSON.stringify(existing), 'utf-8');
      arrangeDaemonState(WORK_STATE);

      await spawnDaemon({ ...WORK_SPAWN, writeRecord: false, recordPort: false });

      expect(JSON.parse(await readFile(DEFAULT_TEST_CONNECTION_FILE, 'utf-8'))).toEqual(existing);
    });

    it('writes nothing when writeRecord is false', async () => {
      arrangeDaemonState(WORK_STATE);

      await spawnDaemon({ ...WORK_SPAWN, writeRecord: false });

      expect(existsSync(DEFAULT_TEST_CONNECTION_FILE)).toBe(false);
    });

    it('does not pass writeRecord to the daemon argv', async () => {
      arrangeDaemonState(WORK_STATE);

      await spawnDaemon({ ...WORK_SPAWN, writeRecord: false });

      const args = vi.mocked(spawnDetached).mock.calls[0][1] as string[];
      expect(args.some(a => a.toLowerCase().includes('writerecord') || a.includes('write-record'))).toBe(false);
    });

    it('does not record a daemon running another profile than requested', async () => {
      arrangeDaemonState({ ...WORK_STATE, profile: 'other' });

      await spawnDaemon(WORK_SPAWN);

      expect(existsSync(DEFAULT_TEST_CONNECTION_FILE)).toBe(false);
    });

    it('leaves no record when the daemon never becomes ready', async () => {
      vi.mocked(spawnDetached).mockImplementation(() => WORK_STATE.pid);

      await expect(spawnDaemon(WORK_SPAWN)).rejects.toThrow('Daemon failed to start');

      expect(existsSync(DEFAULT_TEST_CONNECTION_FILE)).toBe(false);
    }, 15000);

    it('still resolves the daemon state when the record cannot be written', async () => {
      await mkdir(DEFAULT_TEST_CONNECTION_FILE);
      arrangeDaemonState(WORK_STATE);

      await expect(spawnDaemon(WORK_SPAWN)).resolves.toMatchObject({ profile: 'work', pid: WORK_STATE.pid });
    });
  });
});

describe('daemon cleanup never deletes the connection record', () => {
  const DEAD_STATE: DaemonState = { ...SAMPLE_STATE, profile: 'work', pid: 9999999, clientType: 'codemie-claude' };

  afterEach(async () => {
    try { await unlink(DEFAULT_TEST_CONNECTION_FILE); } catch { /* ignore */ }
    try { await unlink(DEFAULT_TEST_STATE_FILE); } catch { /* ignore */ }
    try { await unlink(TEST_STATE_FILE); } catch { /* ignore */ }
  });

  it('checkStatus on a dead pid clears the state file but keeps the record', async () => {
    await writeConnectionRecord(DEAD_STATE, 'work', {}, DEFAULT_TEST_CONNECTION_FILE);
    await writeState(DEAD_STATE, TEST_STATE_FILE);

    const { running } = await checkStatus(TEST_STATE_FILE);

    expect(running).toBe(false);
    expect(existsSync(TEST_STATE_FILE)).toBe(false);
    expect(await readConnectionRecord(DEFAULT_TEST_CONNECTION_FILE)).toMatchObject({ profile: 'work' });
  });

  it('stopDaemon on a dead-pid state clears proxy-daemon.json but keeps the record', async () => {
    await writeConnectionRecord(DEAD_STATE, 'work', {}, DEFAULT_TEST_CONNECTION_FILE);
    await writeState(DEAD_STATE, DEFAULT_TEST_STATE_FILE);

    await stopDaemon();

    expect(existsSync(DEFAULT_TEST_STATE_FILE)).toBe(false);
    expect(await readConnectionRecord(DEFAULT_TEST_CONNECTION_FILE)).toMatchObject({ profile: 'work' });
  });
});

describe('proxy connection record', () => {
  const TEST_CONNECTION_FILE = join(tmpdir(), `codemie-proxy-connection-test-${Date.now()}.json`);
  const RUNNING_STATE: DaemonState = { ...SAMPLE_STATE, profile: 'work', clientType: 'codemie-claude' };

  afterEach(async () => {
    vi.restoreAllMocks();
    try { await unlink(TEST_CONNECTION_FILE); } catch { /* ignore */ }
    const leftovers = (await readdir(tmpdir())).filter(f => f.startsWith('codemie-proxy-connection-test-') && f.endsWith('.tmp'));
    for (const f of leftovers) { try { await unlink(join(tmpdir(), f)); } catch { /* ignore */ } }
  });

  describe('readConnectionRecord', () => {
    it('returns null for a missing file', async () => {
      expect(await readConnectionRecord(TEST_CONNECTION_FILE)).toBeNull();
    });

    it('returns a valid record with its identity fields', async () => {
      await writeFile(TEST_CONNECTION_FILE, JSON.stringify({
        version: 1, profile: 'work', project: 'p', clientType: 'codemie-claude', telemetryMode: 'none', updatedAt: 'now',
      }), 'utf-8');

      const record = await readConnectionRecord(TEST_CONNECTION_FILE);
      expect(record).toMatchObject({ profile: 'work', clientType: 'codemie-claude', telemetryMode: 'none' });
      expect(record).not.toHaveProperty('project');
    });

    it.each([
      ['null', 'null'],
      ['an array', '[]'],
      ['a record without a profile', '{"version":1}'],
      ['a record with an empty profile', '{"version":1,"profile":""}'],
    ])('returns null with a warning for %s', async (_label, content) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await writeFile(TEST_CONNECTION_FILE, content, 'utf-8');

      expect(await readConnectionRecord(TEST_CONNECTION_FILE)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/profile|object/i);
    });

    it('round-trips the port of the clients\' connection', async () => {
      await writeConnectionRecord(RUNNING_STATE, 'work', { port: 52311 }, TEST_CONNECTION_FILE);

      expect((await readConnectionRecord(TEST_CONNECTION_FILE))?.port).toBe(52311);
    });

    it.each([
      ['clientType', { clientType: 7 }],
      ['telemetryMode', { telemetryMode: 'bogus' }],
      ['port', { port: '52311' }],
      ['port', { port: 0 }],
      ['port', { port: -1 }],
    ])('drops a wrongly typed %s with a warning naming the field', async (field, bad) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await writeFile(TEST_CONNECTION_FILE, JSON.stringify({ version: 1, profile: 'work', ...bad }), 'utf-8');

      const record = await readConnectionRecord(TEST_CONNECTION_FILE);

      expect(record?.profile).toBe('work');
      expect(record).not.toHaveProperty(field);
      expect(String(warn.mock.calls[0][0])).toContain(field);
    });
  });

  describe('writeConnectionRecord', () => {
    it('writes the record and returns true', async () => {
      const ok = await writeConnectionRecord({ ...RUNNING_STATE, project: 'p', telemetryMode: 'none' }, 'work', {}, TEST_CONNECTION_FILE);

      expect(ok).toBe(true);
      const record = JSON.parse(await readFile(TEST_CONNECTION_FILE, 'utf-8'));
      expect(record).toMatchObject({ version: 1, profile: 'work' });
      expect(record).not.toHaveProperty('clientType');
      expect(record).not.toHaveProperty('telemetryMode');
      expect(record).not.toHaveProperty('port');
      expect(record).not.toHaveProperty('project');
      expect(typeof record.updatedAt).toBe('string');
      expect(record).not.toHaveProperty('gatewayKey');
      expect(record).not.toHaveProperty('url');
    });

    it('merges over the existing record keeping unknown fields and the legacy identity and port', async () => {
      await writeFile(TEST_CONNECTION_FILE, JSON.stringify({
        version: 1, profile: 'old', clientType: 'claude-desktop', telemetryMode: 'claude-desktop', port: 52311, custom: 'keep-me', updatedAt: 'x',
      }), 'utf-8');

      const ok = await writeConnectionRecord(RUNNING_STATE, 'work', {}, TEST_CONNECTION_FILE);

      expect(ok).toBe(true);
      const record = JSON.parse(await readFile(TEST_CONNECTION_FILE, 'utf-8'));
      expect(record).toMatchObject({
        profile: 'work', clientType: 'claude-desktop', telemetryMode: 'claude-desktop', port: 52311, custom: 'keep-me',
      });
    });

    it('replaces only the port when one is given', async () => {
      await writeFile(TEST_CONNECTION_FILE, JSON.stringify({
        version: 1, profile: 'work', clientType: 'codex-desktop', port: 52311, updatedAt: 'x',
      }), 'utf-8');

      await writeConnectionRecord(RUNNING_STATE, 'work', { port: 60122 }, TEST_CONNECTION_FILE);

      expect(JSON.parse(await readFile(TEST_CONNECTION_FILE, 'utf-8'))).toMatchObject({
        profile: 'work', clientType: 'codex-desktop', port: 60122,
      });
    });

    it('returns false with a warning naming both profiles on a profile mismatch', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      const ok = await writeConnectionRecord(RUNNING_STATE, 'other', {}, TEST_CONNECTION_FILE);

      expect(ok).toBe(false);
      expect(existsSync(TEST_CONNECTION_FILE)).toBe(false);
      const message = warn.mock.calls.map(c => String(c[0])).join(' ');
      expect(message).toContain('work');
      expect(message).toContain('other');
    });

    it('records a daemon whose state names another client type than the record', async () => {
      await writeFile(TEST_CONNECTION_FILE, JSON.stringify({ version: 1, profile: 'work', clientType: 'vscode-byok' }), 'utf-8');

      const ok = await writeConnectionRecord(RUNNING_STATE, 'work', {}, TEST_CONNECTION_FILE);

      expect(ok).toBe(true);
      expect(JSON.parse(await readFile(TEST_CONNECTION_FILE, 'utf-8')).clientType).toBe('vscode-byok');
    });

    it('returns false without throwing when the path is unwritable', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const unwritable = join(tmpdir(), `no-such-dir-${Date.now()}`, 'proxy-connection.json');

      await expect(writeConnectionRecord(RUNNING_STATE, 'work', {}, unwritable)).resolves.toBe(false);
    });

    it('leaves a parseable file after two concurrent writers', async () => {
      const results = await Promise.all([
        writeConnectionRecord(RUNNING_STATE, 'work', {}, TEST_CONNECTION_FILE),
        writeConnectionRecord({ ...RUNNING_STATE, telemetryMode: 'none' }, 'work', {}, TEST_CONNECTION_FILE),
      ]);

      // On Windows a rename over a file another rename is replacing can be refused; a refused
      // writer reports false (never throws), the other one wins and the file stays parseable.
      expect(results).toContain(true);
      expect(JSON.parse(await readFile(TEST_CONNECTION_FILE, 'utf-8')).profile).toBe('work');
      const leftovers = (await readdir(tmpdir())).filter(f => f.startsWith(basename(TEST_CONNECTION_FILE)) && f.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });
  });

  describe('writeConnectionPort', () => {
    it('writes nothing when there is no record', async () => {
      expect(await writeConnectionPort(4001, TEST_CONNECTION_FILE)).toBe(false);

      expect(existsSync(TEST_CONNECTION_FILE)).toBe(false);
    });

    it('sets the port of an existing record and changes nothing else', async () => {
      const existing = { version: 1, profile: 'work', clientType: 'codex-desktop', updatedAt: 'x', custom: 1 };
      await writeFile(TEST_CONNECTION_FILE, JSON.stringify(existing), 'utf-8');

      expect(await writeConnectionPort(4100, TEST_CONNECTION_FILE)).toBe(true);

      expect(JSON.parse(await readFile(TEST_CONNECTION_FILE, 'utf-8'))).toEqual({ ...existing, port: 4100 });
    });
  });

  describe('clearLegacyClientIdentity', () => {
    it('removes clientType and telemetryMode and keeps every other field', async () => {
      await writeFile(TEST_CONNECTION_FILE, JSON.stringify({
        version: 1,
        profile: 'work',
        port: 4100,
        clientType: 'claude-desktop',
        telemetryMode: 'claude-desktop',
        updatedAt: '2026-11-17T00:00:00.000Z',
      }), 'utf-8');

      expect(await clearLegacyClientIdentity(TEST_CONNECTION_FILE)).toBe(true);

      expect(JSON.parse(await readFile(TEST_CONNECTION_FILE, 'utf-8'))).toEqual({
        version: 1,
        profile: 'work',
        port: 4100,
        updatedAt: '2026-11-17T00:00:00.000Z',
      });
    });

    it('does not write a record without them', async () => {
      const text = JSON.stringify({ version: 1, profile: 'work', port: 4100, updatedAt: 'x' });
      await writeFile(TEST_CONNECTION_FILE, text, 'utf-8');

      expect(await clearLegacyClientIdentity(TEST_CONNECTION_FILE)).toBe(false);

      // A write would have replaced the compact text with the writer's indented JSON.
      expect(await readFile(TEST_CONNECTION_FILE, 'utf-8')).toBe(text);
    });

    it('creates nothing when there is no record', async () => {
      expect(await clearLegacyClientIdentity(TEST_CONNECTION_FILE)).toBe(false);

      expect(existsSync(TEST_CONNECTION_FILE)).toBe(false);
    });
  });

  describe('hasLegacyClientIdentity', () => {
    it.each([
      ['clientType', { clientType: 'codex-desktop' }, true],
      ['telemetryMode alone', { telemetryMode: 'none' }, true],
      ['clientType claude-code-otlp', { clientType: 'claude-code-otlp' }, true],
      ['neither field', {}, false],
    ])('answers for a record with %s', async (_case, identity, expected) => {
      await writeFile(TEST_CONNECTION_FILE, JSON.stringify({ version: 1, profile: 'work', port: 4100, ...identity }), 'utf-8');

      expect(await hasLegacyClientIdentity(TEST_CONNECTION_FILE)).toBe(expected);
    });

    it('is false with no record', async () => {
      expect(await hasLegacyClientIdentity(TEST_CONNECTION_FILE)).toBe(false);
    });

    it('is false for a record file that is not JSON', async () => {
      await writeFile(TEST_CONNECTION_FILE, '{"clientType": "claude-desktop"', 'utf-8');

      expect(await hasLegacyClientIdentity(TEST_CONNECTION_FILE)).toBe(false);
    });
  });

  describe('seedConnectionRecord', () => {
    it('writes the record from the running daemon once and logs info', async () => {
      const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

      await seedConnectionRecord(RUNNING_STATE, TEST_CONNECTION_FILE);

      expect(JSON.parse(await readFile(TEST_CONNECTION_FILE, 'utf-8')).profile).toBe('work');
      expect(info).toHaveBeenCalledWith('Seeding proxy-connection.json from the running daemon (profile: work)');
    });

    it('leaves an existing valid record alone', async () => {
      const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      await writeFile(TEST_CONNECTION_FILE, JSON.stringify({ version: 1, profile: 'recorded' }), 'utf-8');

      await seedConnectionRecord(RUNNING_STATE, TEST_CONNECTION_FILE);

      expect(JSON.parse(await readFile(TEST_CONNECTION_FILE, 'utf-8')).profile).toBe('recorded');
      expect(info).not.toHaveBeenCalled();
    });
  });
});
