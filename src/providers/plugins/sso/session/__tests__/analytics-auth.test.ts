import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { JWTCredentials, SSOCredentials } from '@/providers/core/types.js';
import type { SSOAuth } from '../../auth/types.js';

const mockResolveAnalyticsSSOAuth = vi.fn();

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/providers/plugins/sso/auth/index.js', () => ({
  resolveAnalyticsSSOAuth: mockResolveAnalyticsSSOAuth,
}));

const { STORE_READ_DEADLINE_MS, PROXY_STORE_READ_DEADLINE_MS, buildCookieHeader } = await import('../cookie-auth.js');
const {
  NO_ANALYTICS_AUTH,
  analyticsAuthFields,
  fixedCookieAuth,
  hasAnalyticsAuth,
  readAnalyticsAuth,
  resolveAnalyticsAuth,
} = await import('../analytics-auth.js');

const { toSSOAuth } = await import('../../auth/selection.js');

const API = 'https://api.example.invalid';

/** The resolved login the resolver returns for a stored record. */
function stored(record: SSOCredentials | JWTCredentials): SSOAuth {
  return 'token' in record
    ? toSSOAuth({ type: 'jwt', record }, API)
    : toSSOAuth({ type: 'cookie', record }, API);
}

describe('resolveAnalyticsAuth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('cookie credentials', () => {
    it('builds the header from the first read and reads once up front', async () => {
      const read = vi.fn().mockResolvedValue(stored({ cookies: { a: '1', b: '2' }, apiUrl: API }));
      const auth = await resolveAnalyticsAuth(read);
      expect(auth).toMatchObject({ kind: 'cookies', cookies: buildCookieHeader({ a: '1', b: '2' }) });
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('yields no auth for cookies that build no header', async () => {
      for (const cookies of [{}, { 'bad\nname': 'x' }]) {
        const auth = await resolveAnalyticsAuth(vi.fn().mockResolvedValue(stored({ cookies, apiUrl: API })));
        expect(auth).toEqual({ kind: 'none', readTimedOut: false });
      }
    });

    it('reports superseded when the re-read differs', async () => {
      const read = vi
        .fn()
        .mockResolvedValueOnce(stored({ cookies: { s: 'old' }, apiUrl: API }))
        .mockResolvedValueOnce(stored({ cookies: { s: 'new' }, apiUrl: API }));
      const auth = await resolveAnalyticsAuth(read);
      if (auth.kind !== 'cookies') throw new Error(`expected cookie auth, got ${auth.kind}`);
      expect(await auth.credentialsSuperseded(auth.cookies)).toBe(true);
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('reports not superseded when the re-read is equal', async () => {
      const read = vi.fn().mockResolvedValue(stored({ cookies: { s: 'same' }, apiUrl: API }));
      const auth = await resolveAnalyticsAuth(read);
      if (auth.kind !== 'cookies') throw new Error(`expected cookie auth, got ${auth.kind}`);
      expect(await auth.credentialsSuperseded(auth.cookies)).toBe(false);
    });

    // Deliberate behaviour change: a JWT sign-in now supersedes a sent Cookie header.
    it('reports superseded when the re-read finds a JWT instead', async () => {
      const read = vi
        .fn()
        .mockResolvedValueOnce(stored({ cookies: { s: 'old' }, apiUrl: API }))
        .mockResolvedValueOnce(stored({ token: 'jwt', apiUrl: API }));
      const auth = await resolveAnalyticsAuth(read);
      if (auth.kind !== 'cookies') throw new Error(`expected cookie auth, got ${auth.kind}`);
      expect(await auth.credentialsSuperseded(auth.cookies)).toBe(true);
    });

    it('reports not superseded when the re-read throws', async () => {
      const read = vi
        .fn()
        .mockResolvedValueOnce(stored({ cookies: { s: 'old' }, apiUrl: API }))
        .mockRejectedValueOnce(new Error('boom'));
      const auth = await resolveAnalyticsAuth(read);
      if (auth.kind !== 'cookies') throw new Error(`expected cookie auth, got ${auth.kind}`);
      expect(await auth.credentialsSuperseded(auth.cookies)).toBe(false);
    });

    it('reports not superseded when the re-read never answers', async () => {
      const read = vi
        .fn()
        .mockResolvedValueOnce(stored({ cookies: { s: 'old' }, apiUrl: API }))
        .mockImplementationOnce(() => new Promise(() => {}));
      const auth = await resolveAnalyticsAuth(read);
      if (auth.kind !== 'cookies') throw new Error(`expected cookie auth, got ${auth.kind}`);
      const check = auth.credentialsSuperseded(auth.cookies);
      await vi.advanceTimersByTimeAsync(STORE_READ_DEADLINE_MS);
      expect(await check).toBe(false);
    });
  });

  describe('JWT credentials', () => {
    it('yields bearer auth for a stored JWT', async () => {
      const auth = await resolveAnalyticsAuth(vi.fn().mockResolvedValue(stored({ token: 'jwt-1', apiUrl: API })));
      expect(auth).toMatchObject({ kind: 'bearer', jwtToken: 'jwt-1', readTimedOut: false });
    });

    // Deliberate behaviour change: a stored JWT now carries the supersede check too.
    it('reports superseded when a later sign-in replaced the token', async () => {
      const read = vi
        .fn()
        .mockResolvedValueOnce(stored({ token: 'jwt-1', apiUrl: API }))
        .mockResolvedValueOnce(stored({ token: 'jwt-2', apiUrl: API }));
      const auth = await resolveAnalyticsAuth(read);
      if (auth.kind !== 'bearer') throw new Error(`expected bearer auth, got ${auth.kind}`);
      expect(await auth.credentialsSuperseded?.(auth.jwtToken)).toBe(true);
    });

    it('reports not superseded when the re-read finds the same token', async () => {
      const auth = await resolveAnalyticsAuth(vi.fn().mockResolvedValue(stored({ token: 'jwt-1', apiUrl: API })));
      if (auth.kind !== 'bearer') throw new Error(`expected bearer auth, got ${auth.kind}`);
      expect(await auth.credentialsSuperseded?.(auth.jwtToken)).toBe(false);
    });

    it('yields no auth for an empty token', async () => {
      const auth = await resolveAnalyticsAuth(vi.fn().mockResolvedValue(stored({ token: '', apiUrl: API })));
      expect(auth).toEqual({ kind: 'none', readTimedOut: false });
    });

    it('reads the store once', async () => {
      const read = vi.fn().mockResolvedValue(stored({ token: 'jwt-1', apiUrl: API }));
      await resolveAnalyticsAuth(read);
      expect(read).toHaveBeenCalledTimes(1);
    });
  });

  describe('no credentials', () => {
    it('yields no auth when nothing is stored', async () => {
      expect(await resolveAnalyticsAuth(vi.fn().mockResolvedValue(null))).toEqual({ kind: 'none', readTimedOut: false });
    });

    it('yields no auth when the first read throws', async () => {
      const auth = await resolveAnalyticsAuth(vi.fn().mockRejectedValue(new Error('boom')));
      expect(auth.kind).toBe('none');
    });

    it('marks a read cut off by the deadline as timed out, unlike an empty store', async () => {
      const pending = resolveAnalyticsAuth(() => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(STORE_READ_DEADLINE_MS);
      const timedOut = await pending;
      const empty = await resolveAnalyticsAuth(vi.fn().mockResolvedValue(null));

      expect(timedOut).toEqual({ kind: 'none', readTimedOut: true });
      expect(empty).toEqual({ kind: 'none', readTimedOut: false });
    });
  });

  it('waits up to the deadline it is given instead of the default', async () => {
    const read = vi.fn(
      () => new Promise<SSOAuth>((resolve) =>
        setTimeout(() => resolve(stored({ cookies: { a: '1' }, apiUrl: API })), STORE_READ_DEADLINE_MS + 1_000)
      )
    );
    const pending = resolveAnalyticsAuth(read, { deadlineMs: PROXY_STORE_READ_DEADLINE_MS });
    await vi.advanceTimersByTimeAsync(STORE_READ_DEADLINE_MS + 1_000);
    const auth = await pending;

    expect(auth).toMatchObject({ kind: 'cookies', cookies: 'a=1', readTimedOut: false });
  });
});

describe('readAnalyticsAuth', () => {
  beforeEach(() => {
    mockResolveAnalyticsSSOAuth.mockReset();
  });

  it('reads the stored analytics credentials and unwraps the cookies', async () => {
    mockResolveAnalyticsSSOAuth.mockResolvedValue(stored({ cookies: { s: '1' }, apiUrl: API }));
    const env = { CODEMIE_URL: 'https://x' } as NodeJS.ProcessEnv;
    const overrides = { provider: 'ai-run-sso', baseUrl: API };

    const auth = await readAnalyticsAuth('https://sso', env, overrides);

    expect(auth).toMatchObject({ kind: 'cookies', cookies: 's=1' });
    expect(mockResolveAnalyticsSSOAuth).toHaveBeenCalledWith('https://sso', env, overrides);
  });

  it('unwraps a stored JWT as bearer auth', async () => {
    mockResolveAnalyticsSSOAuth.mockResolvedValue(stored({ token: 'jwt-1', apiUrl: API }));

    const auth = await readAnalyticsAuth('https://sso', {} as NodeJS.ProcessEnv);

    expect(auth).toMatchObject({ kind: 'bearer', jwtToken: 'jwt-1' });
  });

  it('re-runs the same read with the same arguments', async () => {
    mockResolveAnalyticsSSOAuth
      .mockResolvedValueOnce(stored({ cookies: { s: 'old' }, apiUrl: API }))
      .mockResolvedValueOnce(stored({ cookies: { s: 'new' }, apiUrl: API }));
    const env = {} as NodeJS.ProcessEnv;
    const overrides = { baseUrl: API };

    const auth = await readAnalyticsAuth('https://sso', env, overrides);
    if (auth.kind !== 'cookies') throw new Error(`expected cookie auth, got ${auth.kind}`);
    expect(await auth.credentialsSuperseded(auth.cookies)).toBe(true);

    expect(mockResolveAnalyticsSSOAuth).toHaveBeenCalledTimes(2);
    expect(mockResolveAnalyticsSSOAuth).toHaveBeenNthCalledWith(1, 'https://sso', env, overrides);
    expect(mockResolveAnalyticsSSOAuth).toHaveBeenNthCalledWith(2, 'https://sso', env, overrides);
  });

  it('yields no auth when no credentials are stored', async () => {
    mockResolveAnalyticsSSOAuth.mockResolvedValue(null);
    const auth = await readAnalyticsAuth('https://sso', {} as NodeJS.ProcessEnv);
    expect(hasAnalyticsAuth(auth)).toBe(false);
  });
});

describe('fixedCookieAuth', () => {
  it('uses handed-in cookies as they are, with no supersede check', () => {
    expect(fixedCookieAuth('s=1')).toEqual({ kind: 'cookies', cookies: 's=1' });
  });

  it('yields no auth for an empty header', () => {
    expect(fixedCookieAuth('')).toBe(NO_ANALYTICS_AUTH);
  });
});

describe('hasAnalyticsAuth', () => {
  it('is true for cookie and bearer auth, false for none', () => {
    expect(hasAnalyticsAuth({ kind: 'cookies', cookies: 's=1' })).toBe(true);
    expect(hasAnalyticsAuth({ kind: 'bearer', jwtToken: 'jwt' })).toBe(true);
    expect(hasAnalyticsAuth(NO_ANALYTICS_AUTH)).toBe(false);
  });
});

describe('analyticsAuthFields', () => {
  it('maps cookie auth to the cookies and the supersede check', () => {
    const credentialsSuperseded = vi.fn();
    expect(analyticsAuthFields({ kind: 'cookies', cookies: 's=1', credentialsSuperseded })).toEqual({
      cookies: 's=1',
      credentialsSuperseded,
    });
  });

  it('omits the supersede check for handed-in cookies', () => {
    expect(analyticsAuthFields(fixedCookieAuth('s=1'))).toEqual({ cookies: 's=1' });
  });

  it('maps bearer auth to the token with an empty cookie header', () => {
    expect(analyticsAuthFields({ kind: 'bearer', jwtToken: 'jwt-1' })).toEqual({ cookies: '', jwtToken: 'jwt-1' });
  });

  it('maps no auth to an empty cookie header only', () => {
    expect(analyticsAuthFields(NO_ANALYTICS_AUTH)).toEqual({ cookies: '' });
  });
});
