/**
 * DaemonManager state file utilities tests
 * @group unit
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink, mkdir, rmdir } from 'fs/promises';
import { existsSync } from 'fs';
import { createServer } from 'http';
import type { AddressInfo } from 'net';

// Override state file path before importing
const TEST_STATE_FILE = join(tmpdir(), `codemie-proxy-daemon-test-${Date.now()}.json`);
const DEFAULT_TEST_STATE_FILE = join(tmpdir(), 'proxy-daemon.json');
vi.mock('../../../../utils/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/paths.js')>();
  return {
    ...actual,
    getCodemieHome: () => tmpdir(),
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

import {
  readState,
  writeState,
  clearState,
  checkStatus,
  daemonStartedAt,
  isDaemonAlive,
  spawnDaemon,
  stopDaemon,
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
  });

  function arrangeReadyDaemon(): void {
    vi.mocked(spawnDetached).mockImplementation(() => {
      void writeFile(DEFAULT_TEST_STATE_FILE, JSON.stringify(SAMPLE_STATE), 'utf-8');
      return SAMPLE_STATE.pid;
    });
  }

  it('passes client and project context without model arguments', async () => {
    arrangeReadyDaemon();

    await spawnDaemon({
      targetUrl: 'https://upstream.example.com',
      provider: 'ai-run-sso',
      profile: 'work',
      port: 4001,
      project: 'team-project',
      clientType: 'vscode-byok',
    });

    const args = vi.mocked(spawnDetached).mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining([
      '--project', 'team-project',
      '--client-type', 'vscode-byok',
    ]));
    expect(args).not.toContain('--model');
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

  it('omits optional client context when it is not configured', async () => {
    arrangeReadyDaemon();

    await spawnDaemon({
      targetUrl: 'https://upstream.example.com',
      provider: 'ai-run-sso',
      profile: 'work',
      port: 4001,
    });

    const args = vi.mocked(spawnDetached).mock.calls[0][1];
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--client-type');
  });
});
