/**
 * PR #655 review (blocking): OtlpInterceptor held the daemon-startup credential snapshot
 * forever, so a successful browser re-login never reached telemetry forwarding — a stale
 * forward kept failing, latching `credentialsStale` for the rest of the process (per
 * auth-state.ts's original header comment: "cannot be refreshed in-process"). These tests
 * cover the fix: a throttled per-tick refresh, and `clearCredentialsStale()` firing only when
 * that refresh actually finds a different credential.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginContext, ProxyInterceptor } from '../types.js';
import { logger } from '../../../../../../utils/logger.js';

const { listSessionIdsMock, processSessionTickMock, getStoredPlatformCredentials } = vi.hoisted(() => ({
  listSessionIdsMock: vi.fn(async () => ['s1']),
  processSessionTickMock: vi.fn(async () => {}),
  getStoredPlatformCredentials: vi.fn(),
}));
vi.mock('../otlp-spool/spool-paths.js', () => ({ listSessionIds: listSessionIdsMock }));
vi.mock('../otlp-spool/tick-processor.js', () => ({ processSessionTick: processSessionTickMock }));
vi.mock('../otlp-spool/sweep.js', () => ({ sweepSpool: vi.fn(async () => {}) }));
vi.mock('@/providers/core/codemie-auth-helpers.js', () => ({ getStoredPlatformCredentials }));

import { OtlpPlugin } from '../otlp.plugin.js';
import { areCredentialsStale, markCredentialsStale } from '../otlp-spool/auth-state.js';
import { sendIntervalMs } from '../otlp-spool/spool-config.js';

function buildContext(credentials: unknown): PluginContext {
  return {
    config: { targetApiUrl: 'https://api.example.com', provider: 'ai-run-sso', sessionId: 'proxy-session' },
    logger,
    credentials: credentials as never,
  } as PluginContext;
}

describe('OtlpInterceptor credential refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listSessionIdsMock.mockClear();
    processSessionTickMock.mockReset();
    processSessionTickMock.mockResolvedValue(undefined);
    getStoredPlatformCredentials.mockReset();
    getStoredPlatformCredentials.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-reads credentials before each tick and resumes forwarding once a fresh one is found', async () => {
    const plugin = new OtlpPlugin();
    const interceptor: ProxyInterceptor = plugin.createInterceptor(
      buildContext({ cookies: { auth: 'stale-cookie' }, apiUrl: 'https://api.example.com' })
    );

    // First tick (fired immediately by onProxyStart) forwards with the startup snapshot, and
    // that forward is rejected (simulating forwarder.ts's real markCredentialsStale call).
    processSessionTickMock.mockImplementationOnce(async () => {
      markCredentialsStale();
    });
    await interceptor.onProxyStart?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(processSessionTickMock).toHaveBeenCalledWith('s1', { cookies: { auth: 'stale-cookie' }, apiUrl: 'https://api.example.com' });
    expect(areCredentialsStale()).toBe(true);

    // Next interval tick: no fresher credentials found yet (refresh returns the same object) —
    // clearCredentialsStale is never called, so forwarding stays suspended. (The real
    // processSessionTick short-circuits on areCredentialsStale() internally; it's mocked here,
    // so this asserts the refresh/clear outcome directly instead.)
    await vi.advanceTimersByTimeAsync(sendIntervalMs());
    expect(areCredentialsStale()).toBe(true);

    // A browser re-login completed between ticks.
    getStoredPlatformCredentials.mockResolvedValueOnce({
      credentials: { cookies: { auth: 'fresh-cookie' }, apiUrl: 'https://api.example.com' },
      url: 'https://api.example.com',
    });
    await vi.advanceTimersByTimeAsync(sendIntervalMs());
    expect(areCredentialsStale()).toBe(false);
    expect(processSessionTickMock).toHaveBeenLastCalledWith('s1', { cookies: { auth: 'fresh-cookie' }, apiUrl: 'https://api.example.com' });

    await interceptor.onProxyStop?.();
  });

  it('does nothing when no credentials are available at all', async () => {
    const plugin = new OtlpPlugin();
    const interceptor: ProxyInterceptor = plugin.createInterceptor(buildContext(undefined));

    await interceptor.onProxyStart?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(processSessionTickMock).not.toHaveBeenCalled();
    expect(getStoredPlatformCredentials).not.toHaveBeenCalled();

    await interceptor.onProxyStop?.();
  });
});
