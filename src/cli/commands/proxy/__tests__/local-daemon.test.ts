/**
 * The local daemon's start, restart and the hook's launcher through the real daemon-manager and daemon lock: the
 * daemon is a stand-in child process that writes its state as the real one does.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OWN_VERSION = '2.0.0';

vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  spawnDetached: vi.fn(),
  // The start-time comparison runs `ps`: a live pid is the daemon.
  isOwnerAlive: vi.fn(async ({ pid }: { pid: number }) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }),
}));
vi.mock('@/utils/cli-updater.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/cli-updater.js')>()),
  getCurrentCliVersion: vi.fn(async () => OWN_VERSION),
}));

let home: string;
const children: ChildProcess[] = [];
/** The ports the stand-in daemon binds instead of the one asked for (a busy port). */
let boundPort: ((asked: number) => number) | undefined;
const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;

/** A live process standing in for a daemon: it only waits, and exits on SIGTERM. */
async function liveProcess(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
  return child.pid as number;
}

const stateFile = () => join(home, 'proxy-daemon.json');
const readStateFile = () => JSON.parse(readFileSync(stateFile(), 'utf-8')) as Record<string, unknown>;

async function writeLiveState(fields: Record<string, unknown>): Promise<number> {
  const pid = await liveProcess();
  const port = (fields.port as number | undefined) ?? 4001;
  writeFileSync(stateFile(), JSON.stringify({
    pid,
    port,
    url: `http://127.0.0.1:${port}`,
    profile: '',
    gatewayKey: 'codemie-proxy',
    startedAt: new Date().toISOString(),
    ...fields,
  }));
  return pid;
}

/** The caller's re-read of the sync settings: `installed` answers `local`; `askedUnderLock` records whether the daemon lock was held at each ask. */
function syncSettings(local: boolean): { installed: () => Promise<boolean>; askedUnderLock: boolean[] } {
  const askedUnderLock: boolean[] = [];
  return {
    askedUnderLock,
    installed: async () => {
      askedUnderLock.push(existsSync(join(home, 'proxy-daemon.lock')));
      return local;
    },
  };
}

/** The arguments of every daemon spawned, after its entry. */
async function spawnedArgs(): Promise<string[][]> {
  const { spawnDetached } = await import('@/utils/processes.js');
  return vi.mocked(spawnDetached).mock.calls.map((call) => (call[1] as string[]).slice(1));
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'local-daemon-'));
  process.env.CODEMIE_HOME = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
  boundPort = undefined;
  const { spawnDetached } = await import('@/utils/processes.js');
  vi.mocked(spawnDetached).mockReset().mockImplementation(((_command: string, args: string[]) => {
    const arg = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const asked = Number(arg('--port') ?? 4001);
    const port = boundPort ? boundPort(asked) : asked;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    // The daemon writes its state once it is up.
    child.once('spawn', () => {
      writeFileSync(arg('--state-file') as string, JSON.stringify({
        pid: child.pid,
        port,
        url: `http://127.0.0.1:${port}`,
        profile: '',
        gatewayKey: arg('--gateway-key'),
        mode: arg('--mode'),
        version: OWN_VERSION,
        startedAt: new Date().toISOString(),
      }));
    });
    return child.pid as number;
  }) as never);
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  vi.useRealTimers();
  await (await import('@/utils/logger.js')).logger.close();
  delete process.env.CODEMIE_HOME;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('localDaemonArgs', () => {
  it('names the local mode, the gateway key, the state file and the port, and no upstream or profile', async () => {
    const { localDaemonArgs } = await import('../local-daemon.js');

    expect(localDaemonArgs({ port: 4001, gatewayKey: 'k', stateFile: '/s.json' })).toEqual([
      '--mode', 'local', '--gateway-key', 'k', '--state-file', '/s.json', '--port', '4001',
    ]);
    expect(localDaemonArgs({ gatewayKey: 'k', stateFile: '/s.json' })).toEqual(['--mode', 'local', '--gateway-key', 'k', '--state-file', '/s.json']);
  });
});

describe('startLocalDaemon', () => {
  it('with no daemon spawns the local one on the port given', async () => {
    const { installed } = syncSettings(true);
    const { startLocalDaemon } = await import('../local-daemon.js');

    const state = await startLocalDaemon(installed, 4555);

    expect(await spawnedArgs()).toEqual([['--mode', 'local', '--gateway-key', 'codemie-proxy', '--state-file', stateFile(), '--port', '4555']]);
    expect(state).toMatchObject({ mode: 'local', port: 4555 });
  });

  it('with a live local daemon of this CLI spawns nothing and answers its state', async () => {
    const { installed } = syncSettings(true);
    const pid = await writeLiveState({ mode: 'local', version: OWN_VERSION, port: 4002 });
    const { startLocalDaemon } = await import('../local-daemon.js');

    const state = await startLocalDaemon(installed);

    expect(await spawnedArgs()).toEqual([]);
    expect(state).toMatchObject({ pid, port: 4002 });
  });

  it('stops an older local daemon and spawns a new one', async () => {
    const { installed } = syncSettings(true);
    const old = await writeLiveState({ mode: 'local', version: '1.0.0' });
    const { startLocalDaemon } = await import('../local-daemon.js');

    const state = await startLocalDaemon(installed, 4556);

    expect(isAlive(old)).toBe(false);
    expect(state).toMatchObject({ mode: 'local', port: 4556, version: OWN_VERSION });
  });

  it('throws with no local in the settings, asked under the lock, and spawns nothing', async () => {
    const { installed, askedUnderLock } = syncSettings(false);
    const { startLocalDaemon } = await import('../local-daemon.js');
    const { ConfigurationError } = await import('@/utils/errors.js');

    await expect(startLocalDaemon(installed, 4555)).rejects.toBeInstanceOf(ConfigurationError);
    expect(askedUnderLock).toEqual([true]);
    expect(await spawnedArgs()).toEqual([]);
  });
});

describe('restartLocalDaemon', () => {
  it('stops the live daemon and starts a new one on its port', async () => {
    const { installed } = syncSettings(true);
    const old = await writeLiveState({ mode: 'local', version: OWN_VERSION, port: 4777 });
    const { restartLocalDaemon } = await import('../local-daemon.js');

    const state = await restartLocalDaemon(installed);

    expect(isAlive(old)).toBe(false);
    expect(state).toMatchObject({ mode: 'local', port: 4777 });
    expect(state.pid).not.toBe(old);
  });
});

describe('ensureLocalOtlpProxy', () => {
  afterEach(() => {
    expect(existsSync(join(home, 'proxy-connection.json'))).toBe(false);
  });

  it('with no state spawns the local daemon, with no upstream, provider or profile', async () => {
    const { installed } = syncSettings(true);
    const { ensureLocalOtlpProxy } = await import('../local-daemon.js');

    await ensureLocalOtlpProxy(installed, 'claude-code-otlp', 'SessionStart');

    const [args] = await spawnedArgs();
    expect(args.slice(0, 2)).toEqual(['--mode', 'local']);
    expect(args).not.toContain('--target-url');
    expect(args).not.toContain('--provider');
    expect(args).not.toContain('--profile');
    expect(readStateFile()).toMatchObject({ mode: 'local' });
  });

  it('adopts a live local daemon of this CLI', async () => {
    const { installed } = syncSettings(true);
    const pid = await writeLiveState({ mode: 'local', version: OWN_VERSION });
    const { ensureLocalOtlpProxy } = await import('../local-daemon.js');

    await ensureLocalOtlpProxy(installed, 'copilot-cli-otlp', 'preToolUse');

    expect(await spawnedArgs()).toEqual([]);
    expect(readStateFile()).toMatchObject({ pid });
  });

  it('replaces an older local daemon, but adopts it as it is on Claude Code\'s UserPromptSubmit', async () => {
    const { installed } = syncSettings(true);
    const old = await writeLiveState({ mode: 'local', version: '1.0.0' });
    const { ensureLocalOtlpProxy } = await import('../local-daemon.js');

    await ensureLocalOtlpProxy(installed, 'claude-code-otlp', 'UserPromptSubmit');
    expect(await spawnedArgs()).toEqual([]);
    expect(isAlive(old)).toBe(true);

    await ensureLocalOtlpProxy(installed, 'claude-code-otlp', 'Stop');
    expect(isAlive(old)).toBe(false);
    expect(readStateFile()).toMatchObject({ mode: 'local', version: OWN_VERSION });
  });

  it('stops a live daemon that is not the local one and spawns the local one with its gateway key', async () => {
    const { installed } = syncSettings(true);
    const backend = await writeLiveState({ version: OWN_VERSION, targetUrl: 'https://api.example.com', provider: 'ai-run-sso', profile: 'work', gatewayKey: 'k-prev' });
    const { ensureLocalOtlpProxy } = await import('../local-daemon.js');

    await ensureLocalOtlpProxy(installed, 'copilot-chat-otlp', 'UserPromptSubmit');

    expect(isAlive(backend)).toBe(false);
    const [args] = await spawnedArgs();
    expect(args).toEqual(expect.arrayContaining(['--mode', 'local', '--gateway-key', 'k-prev']));
    expect(readStateFile()).toMatchObject({ mode: 'local' });
  });

  it('spawns nothing when the settings, asked under the lock, no longer hold local', async () => {
    const { installed, askedUnderLock } = syncSettings(false);
    const { ensureLocalOtlpProxy } = await import('../local-daemon.js');

    await ensureLocalOtlpProxy(installed, 'claude-code-otlp', 'SessionStart');

    expect(askedUnderLock).toEqual([true]);
    expect(await spawnedArgs()).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  describe('edge', () => {
    it('two hooks racing a cold start start one daemon', async () => {
      const { installed } = syncSettings(true);
      const { ensureLocalOtlpProxy } = await import('../local-daemon.js');

      await Promise.all([ensureLocalOtlpProxy(installed, 'claude-code-otlp', 'SessionStart'), ensureLocalOtlpProxy(installed, 'copilot-cli-otlp', 'sessionStart')]);

      expect(await spawnedArgs()).toHaveLength(1);
    });

    it('a busy port gives a free one, and Claude Code\'s endpoint is pointed at its URL', async () => {
      const { installed } = syncSettings(true);
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4001/v1/analytics/otlp',
          OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer codemie-proxy',
        },
      }));
      boundPort = () => 4999;
      const { ensureLocalOtlpProxy } = await import('../local-daemon.js');

      await ensureLocalOtlpProxy(installed, 'claude-code-otlp', 'SessionStart');

      expect((await spawnedArgs())[0]).toEqual(expect.arrayContaining(['--port', '4001']));
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      expect(settings.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:4999/v1/analytics/otlp');
    });

    it('a daemon lock still held after 12 s throws to the hook, and nothing is spawned', async () => {
      const { installed } = syncSettings(true);
      const { processStartedAt } = await import('@/utils/processes.js');
      writeFileSync(join(home, 'proxy-daemon.lock'), JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));
      const { ensureLocalOtlpProxy } = await import('../local-daemon.js');
      const { DaemonLockError } = await import('../daemon-lock.js');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

      let outcome: unknown;
      const run = ensureLocalOtlpProxy(installed, 'claude-code-otlp', 'SessionStart').then(
        () => (outcome = 'resolved'),
        (error: unknown) => (outcome = error)
      );
      // Fake seconds until the outcome is set, bounded well above the lock's 12 s budget.
      for (let second = 0; second < 120 && outcome === undefined; second++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(1000);
      }
      await run;

      expect(outcome).toBeInstanceOf(DaemonLockError);
      expect(await spawnedArgs()).toEqual([]);
    });
  });
});
