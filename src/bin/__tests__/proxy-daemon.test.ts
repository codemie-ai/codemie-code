/**
 * The daemon entry point writes its state file before the Desktop telemetry runtime starts.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatcherCallbacks } from '../../cli/commands/proxy/watcher.js';
import type { AwaitingLoginListener } from '../../cli/commands/proxy/awaiting-login-listener.js';

const runtimeStart = vi.fn();
const writeFileSpy = vi.fn();
const proxyStart = vi.fn();
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
    start = proxyStart;
    stop = async () => undefined;
  },
}));
vi.mock('../../providers/plugins/sso/proxy/plugins/index.js', () => ({}));
vi.mock('../../telemetry/clients/claude-desktop/ClaudeDesktopTelemetryAdapter.js', () => ({
  ClaudeDesktopTelemetryAdapter: class {},
}));
vi.mock('../../telemetry/runtime/DesktopRepositoryResolver.js', () => ({
  DesktopRepositoryResolver: class {},
}));
vi.mock('../../telemetry/runtime/DesktopTelemetryRuntime.js', () => ({
  DesktopTelemetryRuntime: class {
    start = runtimeStart;
    triggerPoll = async () => undefined;
    stop = async () => undefined;
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

describe('proxy-daemon entry point', () => {
  const originalArgv = process.argv;
  const signalListeners = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
  let tempDir: string;
  let stateFile: string;

  beforeEach(async () => {
    vi.resetModules();
    proxyStart.mockReset().mockResolvedValue({ port: 47999, url: 'http://127.0.0.1:47999' });
    storedCredentials.mockReset().mockResolvedValue({ credentials: { cookies: { test: 'synthetic' } } });
    tempDir = await mkdtemp(join(tmpdir(), 'proxy-daemon-'));
    stateFile = join(tempDir, 'proxy-daemon.json');
    process.argv = [
      'node', 'proxy-daemon',
      '--target-url', 'https://upstream.example.com',
      '--state-file', stateFile,
      '--telemetry-mode', 'claude-desktop',
    ];
  });

  afterEach(async () => {
    await Promise.all(loginListeners.splice(0).map(listener => listener.stop()));
    process.argv = originalArgv;
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signalListeners[signal].includes(listener)) process.off(signal, listener);
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes a live state while the runtime start is still pending', async () => {
    let finishStart!: () => void;
    runtimeStart.mockReturnValue(new Promise<void>(resolve => { finishStart = resolve; }));

    // Not awaited: the module's top-level await holds until the runtime start resolves
    const daemon = import('../proxy-daemon.js');
    await waitFor(() => runtimeStart.mock.calls.length > 0);

    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(await readFile(stateFile, 'utf-8')) as DaemonState;
    expect(state).toMatchObject({ pid: process.pid, port: 47999, telemetryMode: 'claude-desktop' });
    expect(await isDaemonAlive(state)).toBe(true);

    finishStart();
    await daemon;
  });

  it('writes the state through a temp file named after its own pid', async () => {
    process.argv = process.argv.slice(0, -2);

    await import('../proxy-daemon.js');

    expect(writeFileSpy).toHaveBeenCalledWith(`${stateFile}.${process.pid}.tmp`);
    expect(existsSync(stateFile)).toBe(true);
  });

  it('starts a browser sign-in only for a request that carries the gateway key while it holds the port', async () => {
    process.argv = process.argv.slice(0, -2);
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
    process.argv = process.argv.slice(0, -2);
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
});
