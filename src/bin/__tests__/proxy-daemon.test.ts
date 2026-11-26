/**
 * The daemon entry point writes its state file before the Desktop telemetry runtime starts, serves the shared key
 * as the default client of the connection record, and removes only its own state file.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatcherCallbacks } from '../../cli/commands/proxy/watcher.js';
import type { AwaitingLoginListener } from '../../cli/commands/proxy/awaiting-login-listener.js';

const runtimeStart = vi.fn();
const runtimeStop = vi.fn();
const writeFileSpy = vi.fn();
const proxyStart = vi.fn();
const cliVersion = vi.fn();
/** The config each CodeMieProxy was built with, and each runtime's options. */
const proxyConfigs: Array<Record<string, unknown>> = [];
const runtimeConfigs: Array<Record<string, unknown>> = [];
const resolversBuilt: unknown[][] = [];
/** `config.desktopRepositoryResolver` at each proxy `start()`: the moment the proxy creates its plugins. */
const resolversAtStart: unknown[] = [];
const storedCredentials = vi.fn();
const loginListeners: AwaitingLoginListener[] = [];
let watcherCallbacks: WatcherCallbacks;

vi.mock('../../providers/core/codemie-auth-helpers.js', () => ({
  getStoredPlatformCredentials: storedCredentials,
}));
const startSignIn = vi.fn();
const markAuthInvalid = vi.fn();
vi.mock('../../providers/plugins/sso/sso.detached-login.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../providers/plugins/sso/sso.detached-login.js')>()),
  startDetachedSsoLogin: startSignIn,
}));
vi.mock('../../utils/analytics-auth-status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/analytics-auth-status.js')>()),
  markAnalyticsAuthInvalid: markAuthInvalid,
}));
vi.mock('../../cli/commands/proxy/awaiting-login-listener.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cli/commands/proxy/awaiting-login-listener.js')>();
  return {
    ...actual,
    startAwaitingLoginListener: vi.fn(async (opts) => {
      const listener = await actual.startAwaitingLoginListener(opts);
      loginListeners.push(listener);
      return listener;
    }),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: vi.fn((...args: Parameters<typeof actual.writeFile>) => {
      writeFileSpy(args[0]);
      return actual.writeFile(...args);
    }),
  };
});
vi.mock('../../providers/plugins/sso/index.js', () => ({
  CodeMieProxy: class {
    constructor(private readonly config: Record<string, unknown>) { proxyConfigs.push(config); }
    start = (...args: unknown[]) => {
      resolversAtStart.push(this.config.desktopRepositoryResolver);
      return proxyStart(...args);
    };
    stop = async () => undefined;
  },
}));
// The package.json read: the boundary that gives the daemon its version
vi.mock('../../utils/cli-updater.js', () => ({ getCurrentCliVersion: cliVersion }));
vi.mock('../../providers/plugins/sso/proxy/plugins/index.js', () => ({}));
vi.mock('../../telemetry/clients/claude-desktop/ClaudeDesktopTelemetryAdapter.js', () => ({
  ClaudeDesktopTelemetryAdapter: class {},
}));
vi.mock('../../telemetry/runtime/DesktopRepositoryResolver.js', () => ({
  DesktopRepositoryResolver: class {
    constructor(...args: unknown[]) { resolversBuilt.push(args); }
  },
}));
vi.mock('../../telemetry/runtime/DesktopTelemetryRuntime.js', () => ({
  DesktopTelemetryRuntime: class {
    constructor(_adapter: unknown, config: Record<string, unknown>) { runtimeConfigs.push(config); }
    start = runtimeStart;
    triggerPoll = async () => undefined;
    stop = runtimeStop;
  },
}));
vi.mock('../../utils/system-proxy-dispatcher.js', () => ({
  installSystemProxyDispatcher: vi.fn(),
}));
vi.mock('../../cli/commands/proxy/watcher.js', () => ({
  ProxyWatcher: class {
    constructor(_opts: unknown, callbacks: WatcherCallbacks) { watcherCallbacks = callbacks; }
    start = () => undefined;
    stop = () => undefined;
  },
}));

import { isDaemonAlive, type DaemonState } from '../../cli/commands/proxy/daemon-manager.js';

/** Waits (real time) until `condition` holds; fails the test after ~5 s. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition not met');
}

type RuntimeOptions = { onDesktopConnectedChange: (since: string | undefined) => Promise<void> };

describe('proxy-daemon entry point', () => {
  const originalArgv = process.argv;
  const signalListeners = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
  let tempDir: string;
  let stateFile: string;
  let codemieHome: string;

  beforeEach(async () => {
    vi.resetModules();
    proxyStart.mockReset().mockResolvedValue({ port: 47999, url: 'http://127.0.0.1:47999' });
    storedCredentials.mockReset().mockResolvedValue({ credentials: { cookies: { test: 'synthetic' } } });
    runtimeStart.mockReset();
    runtimeStop.mockReset();
    cliVersion.mockReset().mockResolvedValue('1.2.3');
    proxyConfigs.length = 0;
    runtimeConfigs.length = 0;
    resolversBuilt.length = 0;
    resolversAtStart.length = 0;
    tempDir = await mkdtemp(join(tmpdir(), 'proxy-daemon-'));
    stateFile = join(tempDir, 'proxy-daemon.json');
    codemieHome = join(tempDir, '.codemie');
    // Before the daemon's import: the connection record's path is fixed when its module loads
    vi.stubEnv('HOME', tempDir);
    vi.stubEnv('USERPROFILE', tempDir);
    vi.stubEnv('CODEMIE_HOME', codemieHome);
    process.argv = [
      'node', 'proxy-daemon',
      '--target-url', 'https://upstream.example.com',
      '--state-file', stateFile,
      '--model', 'claude-sonnet-5',
    ];
  });

  afterEach(async () => {
    await Promise.all(loginListeners.splice(0).map(listener => listener.stop()));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.argv = originalArgv;
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signalListeners[signal].includes(listener)) process.off(signal, listener);
      }
    }
    await (await import('../../utils/logger.js')).logger.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('writes a live state while the runtime start is still pending', async () => {
    let finishStart!: () => void;
    runtimeStart.mockReturnValue(new Promise<void>(resolve => { finishStart = resolve; }));

    // Not awaited: the module's top-level await holds until the runtime start resolves
    const daemon = import('../proxy-daemon.js');
    await waitFor(() => runtimeStart.mock.calls.length > 0);

    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(await readFile(stateFile, 'utf-8')) as DaemonState;
    expect(state).toMatchObject({ pid: process.pid, port: 47999, model: 'claude-sonnet-5', version: '1.2.3', clientType: 'codemie-daemon' });
    expect(state).not.toHaveProperty('telemetryMode');
    expect(await isDaemonAlive(state)).toBe(true);

    finishStart();
    await daemon;
  });

  it('builds the resolver and the Desktop runtime with no option, on the daemon\'s port and key', async () => {
    await import('../proxy-daemon.js');

    expect(resolversBuilt).toEqual([[]]);
    expect(runtimeConfigs).toEqual([expect.objectContaining({ clientType: 'claude-desktop', port: 47999, gatewayKey: 'codemie-proxy' })]);
    expect(runtimeStart).toHaveBeenCalled();
  });

  it('gives the proxy the resolver before its first start, and the runtime the same instance', async () => {
    await import('../proxy-daemon.js');

    expect(resolversAtStart).toHaveLength(1);
    expect(resolversAtStart[0]).toBeDefined();
    expect(runtimeConfigs[0].repositoryResolver).toBe(resolversAtStart[0]);
  });

  it('edge: the proxy the watcher restarts starts with the same resolver', async () => {
    await import('../proxy-daemon.js');
    await watcherCallbacks.restart();

    expect(resolversAtStart).toHaveLength(2);
    expect(resolversAtStart[1]).toBeDefined();
    expect(resolversAtStart[1]).toBe(resolversAtStart[0]);
  });

  it('serves the shared key as the client the connection record names', async () => {
    await mkdir(codemieHome, { recursive: true });
    await writeFile(join(codemieHome, 'proxy-connection.json'), JSON.stringify({ version: 1, profile: 'p', clientType: 'codex-desktop' }));

    await import('../proxy-daemon.js');

    expect(proxyConfigs[0]).toMatchObject({ clientType: 'codex-desktop' });
    expect(JSON.parse(await readFile(stateFile, 'utf-8'))).toMatchObject({ clientType: 'codex-desktop' });
  });

  it('serves the shared key as codemie-daemon with no connection record', async () => {
    await import('../proxy-daemon.js');

    expect(proxyConfigs[0]).toMatchObject({ clientType: 'codemie-daemon' });
  });

  it.each([
    ['not JSON', '{not json'],
    ['not an object', '["claude-desktop"]'],
    ['without a profile', JSON.stringify({ version: 1, clientType: 'codex-desktop' })],
  ])('edge: a connection record %s gives codemie-daemon and the daemon starts', async (_case, raw) => {
    await mkdir(codemieHome, { recursive: true });
    await writeFile(join(codemieHome, 'proxy-connection.json'), raw);

    await import('../proxy-daemon.js');

    expect(proxyConfigs[0]).toMatchObject({ clientType: 'codemie-daemon' });
    expect(JSON.parse(await readFile(stateFile, 'utf-8'))).toMatchObject({ pid: process.pid, clientType: 'codemie-daemon' });
  });

  it('edge: the --client-type and --telemetry-mode of an older caller are ignored and the daemon starts', async () => {
    process.argv.push('--client-type', 'x', '--telemetry-mode', 'claude-desktop');

    await import('../proxy-daemon.js');

    const state = JSON.parse(await readFile(stateFile, 'utf-8')) as Record<string, unknown>;
    expect(state).toMatchObject({ pid: process.pid, clientType: 'codemie-daemon' });
    expect(state).not.toHaveProperty('telemetryMode');
  });

  it('edge: an unreadable package version gives version 0.0.0 in the state and to the proxy', async () => {
    cliVersion.mockResolvedValue(null);

    await import('../proxy-daemon.js');

    expect(JSON.parse(await readFile(stateFile, 'utf-8'))).toMatchObject({ version: '0.0.0' });
    expect(proxyConfigs[0]).toMatchObject({ version: '0.0.0' });
  });

  it('edge: a health tick and a Desktop connection change at the same moment both land in valid JSON', async () => {
    await import('../proxy-daemon.js');
    const { onDesktopConnectedChange } = runtimeConfigs[0] as unknown as RuntimeOptions;

    await Promise.all([watcherCallbacks.onHealthy!(), onDesktopConnectedChange('2026-11-16T10:00:00.000Z')]);
    expect(JSON.parse(await readFile(stateFile, 'utf-8'))).toMatchObject({
      health: 'ok', desktopConnectedSince: '2026-11-16T10:00:00.000Z',
    });

    await onDesktopConnectedChange(undefined);
    expect(JSON.parse(await readFile(stateFile, 'utf-8'))).not.toHaveProperty('desktopConnectedSince');
  });

  describe('cleanup', () => {
    /** Sends SIGTERM and waits for the cleanup to reach its exit. */
    async function terminate(): Promise<void> {
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      process.emit('SIGTERM');
      await waitFor(() => exit.mock.calls.length > 0);
    }

    it('removes a state file that names this process', async () => {
      await import('../proxy-daemon.js');

      await terminate();

      expect(existsSync(stateFile)).toBe(false);
    });

    it('leaves a state file that names another process', async () => {
      await import('../proxy-daemon.js');
      const successor = JSON.stringify({ pid: process.pid + 1, port: 47999 });
      await writeFile(stateFile, successor);

      await terminate();

      expect(await readFile(stateFile, 'utf-8')).toBe(successor);
    });

    it('edge: a Desktop connection change arriving while the cleanup runs creates no state file again', async () => {
      await import('../proxy-daemon.js');
      const { onDesktopConnectedChange } = runtimeConfigs[0] as unknown as RuntimeOptions;
      // The runtime's final poll on stop sees Desktop connected
      runtimeStop.mockImplementation(() => onDesktopConnectedChange('2026-11-16T10:00:00.000Z'));

      await terminate();

      expect(runtimeStop).toHaveBeenCalled();
      expect(existsSync(stateFile)).toBe(false);
    });
  });

  it('writes the state through a temp file named after its own pid', async () => {
    await import('../proxy-daemon.js');

    expect(writeFileSpy).toHaveBeenCalledWith(`${stateFile}.${process.pid}.tmp`);
    expect(existsSync(stateFile)).toBe(true);
  });

  it('starts a browser sign-in only for a request that carries the gateway key while it holds the port', async () => {
    startSignIn.mockReset().mockResolvedValue('started');
    markAuthInvalid.mockReset().mockResolvedValue(undefined);
    const { AuthenticationError } = await import('../../providers/plugins/sso/proxy/proxy-errors.js');
    proxyStart.mockRejectedValueOnce(new AuthenticationError('SSO credentials not found; run codemie profile login'));
    await import('../proxy-daemon.js');
    const state = JSON.parse(await readFile(stateFile, 'utf-8')) as DaemonState;

    expect(watcherCallbacks.isAwaitingLogin?.()).toBe(true);

    const anonymous = await fetch(`${state.url}/v1/messages`, { signal: AbortSignal.timeout(5000) });
    expect(await anonymous.json()).toMatchObject({ error: { message: 'Invalid API key' } });
    expect(startSignIn).not.toHaveBeenCalled();

    const signedRequest = await fetch(`${state.url}/v1/messages`, {
      headers: { Authorization: `Bearer ${state.gatewayKey}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(signedRequest.status).toBe(401);
    expect(await signedRequest.json()).toMatchObject({
      error: { message: expect.stringContaining('A browser sign-in window has been opened automatically') },
    });
    expect(startSignIn).toHaveBeenCalledWith('https://upstream.example.com');
    expect(markAuthInvalid).toHaveBeenCalledTimes(1);

    // Once the real proxy is back the watcher goes back to deep checks.
    proxyStart.mockResolvedValueOnce({ port: state.port, url: state.url });
    await watcherCallbacks.onUnauthorized!();
    expect(watcherCallbacks.isAwaitingLogin?.()).toBe(false);
  });

  it('restores the held 401 listener after a failed replacement and retries after sign-in', async () => {
    const { AuthenticationError } = await import('../../providers/plugins/sso/proxy/proxy-errors.js');
    proxyStart.mockRejectedValueOnce(new AuthenticationError('SSO credentials not found; run codemie profile login'));
    await import('../proxy-daemon.js');
    const before = JSON.parse(await readFile(stateFile, 'utf-8')) as DaemonState;

    proxyStart.mockRejectedValueOnce(new Error('transient startup failure'));
    await expect(watcherCallbacks.onUnauthorized!()).rejects.toThrow('transient startup failure');
    const response = await fetch(`${before.url}/v1/messages`, {
      headers: { Authorization: `Bearer ${before.gatewayKey}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('Automatic recovery will retry') } });
    expect(JSON.parse(await readFile(stateFile, 'utf-8'))).toMatchObject({ port: before.port, pid: before.pid, health: 'unhealthy' });

    proxyStart.mockResolvedValueOnce({ port: before.port, url: before.url });
    await watcherCallbacks.onUnauthorized!();
    expect(JSON.parse(await readFile(stateFile, 'utf-8'))).toMatchObject({ port: before.port, pid: before.pid, health: 'ok' });
  });

  it('does not register SSO sign-in recovery for a JWT daemon', async () => {
    process.argv.push('--auth-method', 'jwt');
    await import('../proxy-daemon.js');
    expect(watcherCallbacks.onUnauthorized).toBeUndefined();
  });

  it('the watcher\'s check reaches the upstream through the gateway with the state\'s gateway key', async () => {
    const { createServer } = await import('node:http');
    const authorizations: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/v1/llm_models')) authorizations.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      // The proxy is mocked: the port it answers is where the watcher looks, and this server stands in for it.
      proxyStart.mockResolvedValue({ port, url: `http://127.0.0.1:${port}` });
      process.argv.push('--gateway-key', 'codemie-proxy-test');
      await import('../proxy-daemon.js');
      const state = JSON.parse(await readFile(stateFile, 'utf-8')) as DaemonState;

      expect(await watcherCallbacks.check()).toMatchObject({ healthy: true, level: 'deep' });
      expect(authorizations).toEqual([`Bearer ${state.gatewayKey}`]);
      expect(state.gatewayKey).toBe('codemie-proxy-test');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  // Last in the file: these cases load the real proxy and the real plugin set, which stay unmocked for what follows.
  describe('--mode local', () => {
    beforeEach(() => {
      vi.doUnmock('../../providers/plugins/sso/index.js');
      vi.doUnmock('../../providers/plugins/sso/proxy/plugins/index.js');
      vi.doMock('../../providers/core/codemie-auth-helpers.js', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../../providers/core/codemie-auth-helpers.js')>()),
        getStoredPlatformCredentials: storedCredentials,
      }));
    });

    /** A port nothing listens on, so no case binds the default 4001. */
    async function freePort(): Promise<number> {
      const { createServer } = await import('node:net');
      const server = createServer();
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      await new Promise<void>(resolve => server.close(() => resolve()));
      return port;
    }

    async function terminate(): Promise<void> {
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      process.emit('SIGTERM');
      await waitFor(() => exit.mock.calls.length > 0);
    }

    async function enabledPluginIds(): Promise<string[]> {
      const { getPluginRegistry } = await import('../../providers/plugins/sso/proxy/plugins/registry.js');
      const registry = getPluginRegistry();
      return registry.getAll().filter(plugin => registry.getConfig(plugin.id)?.enabled).map(plugin => plugin.id).sort();
    }

    it('binds the real proxy with no target URL and no credentials, serving the local plugin set alone', async () => {
      const port = await freePort();
      process.argv = ['node', 'proxy-daemon', '--mode', 'local', '--state-file', stateFile, '--port', String(port)];

      await import('../proxy-daemon.js');
      try {
        const state = JSON.parse(await readFile(stateFile, 'utf-8')) as DaemonState;
        expect(state).toMatchObject({ pid: process.pid, port, mode: 'local', profile: '', version: '1.2.3' });
        expect(state).not.toHaveProperty('targetUrl');
        expect(state).not.toHaveProperty('provider');
        expect(storedCredentials).not.toHaveBeenCalled();
        expect(loginListeners).toEqual([]);
        expect(runtimeConfigs).toEqual([]);
        expect(runtimeStart).not.toHaveBeenCalled();
        expect(await enabledPluginIds()).toEqual(['@codemie/local-analytics', '@codemie/no-upstream', '@codemie/proxy-gateway-key']);

        const response = await fetch(`${state.url}/v1/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.gatewayKey}` },
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status).toBe(404);
        expect(await watcherCallbacks.check()).toMatchObject({ healthy: true, level: 'shallow' });
      } finally {
        await terminate();
      }
    });

    it('the watcher\'s restart brings the proxy back on its port and records the recovery; its give-up records the reason', async () => {
      const port = await freePort();
      process.argv = ['node', 'proxy-daemon', '--mode', 'local', '--state-file', stateFile, '--port', String(port)];

      await import('../proxy-daemon.js');
      try {
        await watcherCallbacks.restart();
        const state = JSON.parse(await readFile(stateFile, 'utf-8')) as DaemonState & Record<string, unknown>;
        expect(state).toMatchObject({
          url: `http://127.0.0.1:${port}`,
          health: 'ok',
          lastHealthyAt: expect.any(String),
          lastRecoveryAt: expect.any(String),
        });
        expect(state).not.toHaveProperty('healthReason');
        const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.gatewayKey}` },
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status).toBe(404);

        await watcherCallbacks.onGiveUp('health check failed 3 times');
        expect(JSON.parse(await readFile(stateFile, 'utf-8'))).toMatchObject({ health: 'unhealthy', healthReason: 'health check failed 3 times' });
      } finally {
        await terminate();
      }
    });

    it('without --mode and --target-url exits 1 as before', async () => {
      process.argv = ['node', 'proxy-daemon', '--state-file', stateFile];
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);

      await expect(import('../proxy-daemon.js')).rejects.toThrow('exit 1');
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('without --mode the plugin set is every registered plugin but the local daemon\'s two', async () => {
      // The proxy itself stays a stand-in here: a real one would start the backend plugins.
      vi.doMock('../../providers/plugins/sso/index.js', () => ({
        CodeMieProxy: class {
          start = async () => ({ port: 47999, url: 'http://127.0.0.1:47999' });
          stop = async () => undefined;
        },
      }));
      await import('../proxy-daemon.js');
      const { getPluginRegistry } = await import('../../providers/plugins/sso/proxy/plugins/registry.js');
      const all = getPluginRegistry().getAll().map(plugin => plugin.id);

      expect(await enabledPluginIds()).toEqual(all.filter(id => id !== '@codemie/local-analytics' && id !== '@codemie/no-upstream').sort());
      expect(all).toEqual(expect.arrayContaining(['@codemie/otlp', '@codemie/proxy-gateway-key']));
    });
  });
});
