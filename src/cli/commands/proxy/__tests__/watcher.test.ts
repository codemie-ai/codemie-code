import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProxyWatcher, WatcherCallbacks } from '../watcher.js';
import type { ProxyHealthResult } from '../health-check.js';
import { checkProxyHealth } from '../health-check.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../health-check.js', () => ({
  checkProxyHealth: vi.fn(),
}));

const mockedHealth = vi.mocked(checkProxyHealth);

const HEALTHY: ProxyHealthResult = { healthy: true, level: 'deep', code: 'ok' };
const UPSTREAM_DOWN: ProxyHealthResult = {
  healthy: false, level: 'deep', code: 'upstream-error', reason: 'Upstream model discovery returned 500',
};
const UNAUTHORIZED: ProxyHealthResult = {
  healthy: false,
  level: 'deep',
  code: 'unauthorized',
  reason: 'SSO session expired — run `codemie profile login`; the proxy resumes automatically.',
};

function makeCallbacks(): WatcherCallbacks & {
  restart: ReturnType<typeof vi.fn>;
  onHealthy: ReturnType<typeof vi.fn>;
  onGiveUp: ReturnType<typeof vi.fn>;
  onAuthRequired: ReturnType<typeof vi.fn>;
  hasNewCredentials: ReturnType<typeof vi.fn>;
  onCredentialsRestored: ReturnType<typeof vi.fn>;
} {
  return {
    restart: vi.fn().mockResolvedValue(undefined),
    onHealthy: vi.fn().mockResolvedValue(undefined),
    onGiveUp: vi.fn().mockResolvedValue(undefined),
    onAuthRequired: vi.fn().mockResolvedValue(undefined),
    hasNewCredentials: vi.fn().mockResolvedValue(false),
    onCredentialsRestored: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ProxyWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedHealth.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports healthy and never restarts while the proxy is healthy', async () => {
    mockedHealth.mockResolvedValue(HEALTHY);
    const cb = makeCallbacks();
    const watcher = new ProxyWatcher({ port: 4001, gatewayKey: 'k', intervalMs: 1000 }, cb);

    watcher.start();
    // Drive several ticks.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    watcher.stop();

    expect(cb.onHealthy).toHaveBeenCalled();
    expect(cb.restart).not.toHaveBeenCalled();
    expect(cb.onGiveUp).not.toHaveBeenCalled();
  });

  it('restarts up to maxRestartAttempts, then gives up, when upstream stays down', async () => {
    mockedHealth.mockResolvedValue(UPSTREAM_DOWN);
    const cb = makeCallbacks();
    const watcher = new ProxyWatcher(
      { port: 4001, gatewayKey: 'k', intervalMs: 1000, maxRestartAttempts: 3 },
      cb
    );

    watcher.start();
    // Advance generously past 3 restart cycles (interval + backoff each) and the give-up tick.
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    watcher.stop();

    expect(cb.restart).toHaveBeenCalledTimes(3);
    expect(cb.onGiveUp).toHaveBeenCalledTimes(1);
    expect(cb.onGiveUp.mock.calls[0][0]).toContain('did not recover after 3 restart attempts');
  });

  it('waits for a sign-in on an unauthorized failure instead of restarting or giving up', async () => {
    mockedHealth.mockResolvedValue(UNAUTHORIZED);
    const cb = makeCallbacks();
    const watcher = new ProxyWatcher(
      { port: 4001, gatewayKey: 'k', intervalMs: 1000, authPollMs: 200 },
      cb
    );

    watcher.start();
    await vi.advanceTimersByTimeAsync(1000);
    // Many poll periods later: still waiting, still polling the credential store.
    await vi.advanceTimersByTimeAsync(5000);
    watcher.stop();

    expect(cb.onAuthRequired).toHaveBeenCalledTimes(1);
    expect(cb.onAuthRequired.mock.calls[0][0]).toContain('SSO session expired');
    expect(cb.restart).not.toHaveBeenCalled();
    expect(cb.onGiveUp).not.toHaveBeenCalled();
    expect(cb.hasNewCredentials.mock.calls.length).toBeGreaterThan(5);
    // Deep checks go through the proxy and would re-open the browser sign-in: only the first one runs.
    expect(mockedHealth).toHaveBeenCalledTimes(1);
  });

  it('resumes after a new sign-in: restores the proxy, re-checks health, reports healthy', async () => {
    mockedHealth
      .mockResolvedValueOnce(UNAUTHORIZED)
      .mockResolvedValue(HEALTHY);
    const cb = makeCallbacks();
    const watcher = new ProxyWatcher(
      { port: 4001, gatewayKey: 'k', intervalMs: 1000, authPollMs: 200 },
      cb
    );

    watcher.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(cb.onAuthRequired).toHaveBeenCalledTimes(1);

    cb.hasNewCredentials.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(400);
    watcher.stop();

    expect(cb.onCredentialsRestored).toHaveBeenCalledTimes(1);
    expect(mockedHealth).toHaveBeenCalledTimes(2);
    expect(cb.onHealthy).toHaveBeenCalled();
    expect(cb.restart).not.toHaveBeenCalled();
  });

  it('re-enters the waiting state if the new credentials are rejected too', async () => {
    mockedHealth.mockResolvedValue(UNAUTHORIZED);
    const cb = makeCallbacks();
    const watcher = new ProxyWatcher(
      { port: 4001, gatewayKey: 'k', intervalMs: 1000, authPollMs: 200 },
      cb
    );

    watcher.start();
    await vi.advanceTimersByTimeAsync(1000);
    cb.hasNewCredentials.mockResolvedValueOnce(true).mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(2000);
    watcher.stop();

    expect(cb.onCredentialsRestored).toHaveBeenCalledTimes(1);
    expect(cb.onAuthRequired).toHaveBeenCalledTimes(2);
    expect(cb.onGiveUp).not.toHaveBeenCalled();
  });

  it('recovers and resets attempts when health returns after a restart', async () => {
    // First tick unhealthy → triggers a restart; subsequent ticks healthy.
    mockedHealth
      .mockResolvedValueOnce(UPSTREAM_DOWN)
      .mockResolvedValue(HEALTHY);
    const cb = makeCallbacks();
    const watcher = new ProxyWatcher(
      { port: 4001, gatewayKey: 'k', intervalMs: 1000, maxRestartAttempts: 3 },
      cb
    );

    watcher.start();
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    watcher.stop();

    expect(cb.restart).toHaveBeenCalledTimes(1);
    expect(cb.onHealthy).toHaveBeenCalled();
    expect(cb.onGiveUp).not.toHaveBeenCalled();
  });

  it('stops cleanly: no checks fire after stop()', async () => {
    mockedHealth.mockResolvedValue(HEALTHY);
    const cb = makeCallbacks();
    const watcher = new ProxyWatcher({ port: 4001, gatewayKey: 'k', intervalMs: 1000 }, cb);

    watcher.start();
    watcher.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockedHealth).not.toHaveBeenCalled();
  });
});
