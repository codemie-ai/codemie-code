import { describe, it, expect, vi } from 'vitest';
import {
  ProxyHost,
  fingerprintCredentials,
  isSsoAuthFailure,
  type HostedAuthServer,
  type HostedProxy,
} from '../proxy-host.js';
import { AuthenticationError } from '@/providers/plugins/sso/proxy/proxy-errors.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function fakeProxy(start: () => Promise<{ port: number; url: string }>): HostedProxy & { stop: ReturnType<typeof vi.fn> } {
  return { start: vi.fn(start), stop: vi.fn().mockResolvedValue(undefined) };
}

function fakeAuthServer(): HostedAuthServer & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  return { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
}

const OK = async () => ({ port: 4001, url: 'http://127.0.0.1:4001' });
const NO_LOGIN = async () => { throw new AuthenticationError('SSO credentials not found'); };

describe('ProxyHost', () => {
  it('restart rebuilds the full proxy when credentials are available', async () => {
    const first = fakeProxy(OK);
    const second = fakeProxy(OK);
    const proxies = [first, second];
    const host = new ProxyHost({
      createProxy: () => proxies.shift()!,
      createAuthServer: fakeAuthServer,
      isAuthFailure: isSsoAuthFailure,
    });

    await host.start();
    const result = await host.restart();

    expect(first.stop).toHaveBeenCalled();
    expect(result).toEqual({ mode: 'full', url: 'http://127.0.0.1:4001' });
    expect(host.mode).toBe('full');
  });

  it('keeps the port bound with the auth-required listener when the login is gone', async () => {
    // Regression: the old restart stopped the proxy, start() threw, and nothing was left listening.
    const first = fakeProxy(OK);
    const failing = fakeProxy(NO_LOGIN);
    const proxies = [first, failing];
    const authServer = fakeAuthServer();
    const host = new ProxyHost({
      createProxy: () => proxies.shift()!,
      createAuthServer: () => authServer,
      isAuthFailure: isSsoAuthFailure,
    });

    await host.start();
    const result = await host.restart();

    expect(result).toEqual({ mode: 'auth-required' });
    expect(host.mode).toBe('auth-required');
    expect(authServer.start).toHaveBeenCalledTimes(1);
  });

  it('swaps the auth-required listener back out when the proxy can be rebuilt', async () => {
    const authServer = fakeAuthServer();
    const proxies = [fakeProxy(OK), fakeProxy(NO_LOGIN), fakeProxy(OK)];
    const host = new ProxyHost({
      createProxy: () => proxies.shift()!,
      createAuthServer: () => authServer,
      isAuthFailure: isSsoAuthFailure,
    });

    await host.start();
    await host.restart();
    const result = await host.restart();

    expect(authServer.stop).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe('full');
    expect(host.mode).toBe('full');
  });

  it('still throws for failures that are not a missing login, so the watcher can retry', async () => {
    const proxies = [fakeProxy(OK), fakeProxy(async () => { throw new Error('EADDRINUSE'); })];
    const authServer = fakeAuthServer();
    const host = new ProxyHost({
      createProxy: () => proxies.shift()!,
      createAuthServer: () => authServer,
      isAuthFailure: isSsoAuthFailure,
    });

    await host.start();
    await expect(host.restart()).rejects.toThrow('EADDRINUSE');
    expect(authServer.start).not.toHaveBeenCalled();
  });

  it('stop() stops whichever server is running', async () => {
    const authServer = fakeAuthServer();
    const proxies = [fakeProxy(OK), fakeProxy(NO_LOGIN)];
    const host = new ProxyHost({
      createProxy: () => proxies.shift()!,
      createAuthServer: () => authServer,
      isAuthFailure: isSsoAuthFailure,
    });
    await host.start();
    await host.restart();

    await host.stop();

    expect(authServer.stop).toHaveBeenCalledTimes(1);
  });
});

describe('fingerprintCredentials', () => {
  it('is null when nothing is stored or there are no cookies', () => {
    expect(fingerprintCredentials(null)).toBeNull();
    expect(fingerprintCredentials({})).toBeNull();
    expect(fingerprintCredentials({ cookies: {} })).toBeNull();
  });

  it('is stable regardless of cookie order and changes when a value changes', () => {
    const a = fingerprintCredentials({ cookies: { x: 'secret-1', y: '2' } });
    const b = fingerprintCredentials({ cookies: { y: '2', x: 'secret-1' } });
    const c = fingerprintCredentials({ cookies: { x: 'secret-1', y: '3' } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // a digest, not the cookie values
  });
});
