/**
 * The start of a daemon process: the arguments, the wait for the child's own state, and the connection record
 * `spawnDaemon` writes.
 * @group unit
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, readFile, unlink, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';

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
    isOwnerAlive: vi.fn(async () => true),
  };
});

import { processStartedAt, spawnDetached } from '../../../../utils/processes.js';
import { logger } from '../../../../utils/logger.js';
import type { DaemonState } from '../daemon-manager.js';
import { spawnDaemon, spawnDaemonProcess } from '../daemon-spawn.js';

// Never a real request: a proxy on this machine (the user's daemon on 4001) must not answer a test
vi.stubGlobal('fetch', vi.fn(async () => {
  throw new TypeError('fetch failed: ECONNREFUSED');
}));

const SAMPLE_STATE: DaemonState = {
  pid: process.pid,
  port: 4001,
  url: 'http://localhost:4001',
  profile: 'default',
  gatewayKey: 'codemie-proxy',
  startedAt: new Date(processStartedAt()).toISOString(),
};

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

  it('spawnDaemonProcess spawns the arguments it is given and writes no connection record', async () => {
    arrangeReadyDaemon();

    const state = await spawnDaemonProcess(['/opt/bin/proxy-daemon.js', '--mode', 'local', '--state-file', DEFAULT_TEST_STATE_FILE]);

    expect(vi.mocked(spawnDetached).mock.calls[0]).toEqual([
      process.execPath,
      ['/opt/bin/proxy-daemon.js', '--mode', 'local', '--state-file', DEFAULT_TEST_STATE_FILE],
    ]);
    expect(state).toMatchObject({ pid: SAMPLE_STATE.pid });
    expect(existsSync(DEFAULT_TEST_CONNECTION_FILE)).toBe(false);
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
