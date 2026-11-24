import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetStoredAnalyticsCredentials = vi.fn();

const mockLoggerDebug = vi.hoisted(() => vi.fn());

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: mockLoggerDebug },
}));
vi.mock('@/providers/core/codemie-auth-helpers.js', () => ({
  getStoredAnalyticsCredentials: mockGetStoredAnalyticsCredentials,
}));

const {
  STORE_READ_DEADLINE_MS,
  PROXY_STORE_READ_DEADLINE_MS,
  buildCookieHeader,
  droppedCookieKeys,
  readWithDeadline,
  sentCredentialsSuperseded,
  supersedingCookieHeader,
  readCookieAuth,
  readAnalyticsCookieAuth,
} = await import('../cookie-auth.js');

type Creds = { cookies: Record<string, string> };

describe('buildCookieHeader', () => {
  it('joins name=value pairs with "; "', () => {
    expect(buildCookieHeader({ a: '1', b: '2' })).toBe('a=1; b=2');
  });

  it('drops entries with empty names or control characters', () => {
    expect(
      buildCookieHeader({
        '': 'x',
        '  ': 'y',
        'bad\nname': 'z',
        okName: 'bad\u0000value',
        del: 'v\u007f',
        good: 'ok',
      })
    ).toBe('good=ok');
  });

  it('returns an empty string when nothing is usable', () => {
    expect(buildCookieHeader({})).toBe('');
    expect(buildCookieHeader({ '': 'x' })).toBe('');
  });
});

describe('droppedCookieKeys', () => {
  it('lists the names buildCookieHeader leaves out, an empty name as <empty>, and never a value', () => {
    expect(droppedCookieKeys({ a: '1', '': 'x', ' ': 'y', bad: 'l\nb', 'n\nm': 'v' })).toEqual([
      '<empty>',
      '<empty>',
      'bad',
      'n\nm',
    ]);
  });

  it('is empty when every entry is usable', () => {
    expect(droppedCookieKeys({ a: '1', b: '2' })).toEqual([]);
  });
});

describe('sentCredentialsSuperseded', () => {
  it('is true when the re-read header differs from the sent one', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue({ cookies: { s: 'new' } }) };
    expect(await sentCredentialsSuperseded('s=old', source)).toBe(true);
  });

  it('is false when headers are equal', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue({ cookies: { s: 'same' } }) };
    expect(await sentCredentialsSuperseded('s=same', source)).toBe(false);
  });

  it('is false without a source', async () => {
    expect(await sentCredentialsSuperseded('s=old')).toBe(false);
  });

  it('is false when nothing was sent, without consulting the source', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue({ cookies: { s: 'new' } }) };
    expect(await sentCredentialsSuperseded('', source)).toBe(false);
    expect(await sentCredentialsSuperseded(undefined, source)).toBe(false);
  });

  it('is false when the store yields nothing', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue(null) };
    expect(await sentCredentialsSuperseded('s=old', source)).toBe(false);
  });

  it('is false when the re-read throws', async () => {
    const source = { refreshNow: vi.fn().mockRejectedValue(new Error('boom')) };
    expect(await sentCredentialsSuperseded('s=old', source)).toBe(false);
  });

  it('is false when the re-read builds an empty header', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue({ cookies: { '': 'x' } }) };
    expect(await sentCredentialsSuperseded('s=old', source)).toBe(false);
  });
});

describe('supersedingCookieHeader', () => {
  it('returns the stored header when it differs from the sent one', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue({ cookies: { s: 'new' } }) };
    expect(await supersedingCookieHeader('s=old', source)).toBe('s=new');
  });

  it.each([
    ['equal headers', 's=same', { cookies: { s: 'same' } }],
    ['an empty store', 's=old', null],
    ['an unusable stored header', 's=old', { cookies: { '': 'x' } }],
  ])('returns null for %s', async (_label, sent, stored) => {
    const source = { refreshNow: vi.fn().mockResolvedValue(stored) };
    expect(await supersedingCookieHeader(sent, source)).toBeNull();
  });

  it('returns null when the re-read throws, without a source or when nothing was sent', async () => {
    expect(await supersedingCookieHeader('s=old', { refreshNow: vi.fn().mockRejectedValue(new Error('boom')) })).toBeNull();
    expect(await supersedingCookieHeader('s=old')).toBeNull();
    expect(await supersedingCookieHeader('', { refreshNow: vi.fn() })).toBeNull();
  });
});

describe('readWithDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the value of a read that answers in time and clears the timer', async () => {
    const guarded = readWithDeadline(async () => ({ v: 1 }));
    expect(await guarded()).toEqual({ v: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns null when the read throws and clears the timer', async () => {
    const guarded = readWithDeadline<Creds>(async () => {
      throw new Error('boom');
    });
    expect(await guarded()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns null when the read yields nothing', async () => {
    const guarded = readWithDeadline<Creds>(async () => null);
    expect(await guarded()).toBeNull();
  });

  it('returns null after the deadline for a read that never answers', async () => {
    const guarded = readWithDeadline<Creds>(() => new Promise(() => {}));
    const result = guarded();
    await vi.advanceTimersByTimeAsync(STORE_READ_DEADLINE_MS);
    expect(await result).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours a custom deadline', async () => {
    const guarded = readWithDeadline<Creds>(() => new Promise(() => {}), 50);
    const result = guarded();
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBeNull();
  });

  it('ignores a late result of a timed-out read', async () => {
    let resolveRead!: (v: Creds | null) => void;
    const read = vi.fn(() => new Promise<Creds | null>((r) => { resolveRead = r; }));
    const guarded = readWithDeadline(read);

    const first = guarded();
    await vi.advanceTimersByTimeAsync(STORE_READ_DEADLINE_MS);
    expect(await first).toBeNull();

    resolveRead({ cookies: { late: '1' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toBeNull();
  });

  it('starts a fresh read on the next call while the timed-out read is still unsettled', async () => {
    const read = vi
      .fn<() => Promise<Creds | null>>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ cookies: { fresh: '1' } });
    const guarded = readWithDeadline(read);

    const first = guarded();
    await vi.advanceTimersByTimeAsync(STORE_READ_DEADLINE_MS);
    expect(await first).toBeNull();

    expect(await guarded()).toEqual({ cookies: { fresh: '1' } });
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let the late result of an abandoned read leak into a later call', async () => {
    let resolveFirst!: (v: Creds | null) => void;
    const read = vi
      .fn<() => Promise<Creds | null>>()
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ cookies: { fresh: '1' } });
    const guarded = readWithDeadline(read);

    const first = guarded();
    await vi.advanceTimersByTimeAsync(STORE_READ_DEADLINE_MS);
    await first;

    const second = await guarded();
    resolveFirst({ cookies: { late: '1' } });
    await vi.advanceTimersByTimeAsync(0);

    expect(second).toEqual({ cookies: { fresh: '1' } });
  });

  it('unrefs its timer', async () => {
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const handle = realSetTimeout(...args);
      handle.unref = (() => { unref(); return handle; }) as typeof handle.unref;
      return handle;
    }) as typeof setTimeout);
    const guarded = readWithDeadline(async () => ({ v: 1 }));
    await guarded();
    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('readCookieAuth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds the header from the first read and reads once up front', async () => {
    const read = vi.fn().mockResolvedValue({ cookies: { a: '1', b: '2' } });
    const auth = await readCookieAuth(read);
    expect(auth.cookies).toBe(buildCookieHeader({ a: '1', b: '2' }));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('returns an empty header when nothing is stored', async () => {
    const auth = await readCookieAuth(vi.fn().mockResolvedValue(null));
    expect(auth.cookies).toBe('');
  });

  it('returns an empty header when the first read throws', async () => {
    const auth = await readCookieAuth(vi.fn().mockRejectedValue(new Error('boom')));
    expect(auth.cookies).toBe('');
  });

  it('reports superseded when the re-read differs', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ cookies: { s: 'old' } })
      .mockResolvedValueOnce({ cookies: { s: 'new' } });
    const auth = await readCookieAuth(read);
    expect(await auth.credentialsSuperseded(auth.cookies)).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reports not superseded when the re-read is equal', async () => {
    const read = vi.fn().mockResolvedValue({ cookies: { s: 'same' } });
    const auth = await readCookieAuth(read);
    expect(await auth.credentialsSuperseded(auth.cookies)).toBe(false);
  });

  it('reports not superseded when the re-read is null', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ cookies: { s: 'old' } })
      .mockResolvedValueOnce(null);
    const auth = await readCookieAuth(read);
    expect(await auth.credentialsSuperseded(auth.cookies)).toBe(false);
  });

  it('reports not superseded when the re-read throws', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ cookies: { s: 'old' } })
      .mockRejectedValueOnce(new Error('boom'));
    const auth = await readCookieAuth(read);
    expect(await auth.credentialsSuperseded(auth.cookies)).toBe(false);
  });

  it('yields an empty header when the first read never answers, and a later check starts a fresh read', async () => {
    const read = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ cookies: { s: 'new' } });
    const pending = readCookieAuth(read);
    await vi.advanceTimersByTimeAsync(STORE_READ_DEADLINE_MS);
    const auth = await pending;

    expect(auth.cookies).toBe('');
    expect(await auth.credentialsSuperseded('s=old')).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('marks a read cut off by the deadline as timed out, unlike an empty store', async () => {
    const pending = readCookieAuth(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(STORE_READ_DEADLINE_MS);
    const timedOut = await pending;
    const empty = await readCookieAuth(vi.fn().mockResolvedValue(null));

    expect(timedOut).toMatchObject({ cookies: '', readTimedOut: true });
    expect(empty).toMatchObject({ cookies: '', readTimedOut: false });
  });

  it('waits up to the deadline it is given instead of the default', async () => {
    const read = vi.fn(
      () => new Promise<{ cookies: Record<string, string> }>((resolve) => setTimeout(() => resolve({ cookies: { a: '1' } }), STORE_READ_DEADLINE_MS + 1_000))
    );
    const pending = readCookieAuth(read, { deadlineMs: PROXY_STORE_READ_DEADLINE_MS });
    await vi.advanceTimersByTimeAsync(STORE_READ_DEADLINE_MS + 1_000);
    const auth = await pending;

    expect(auth).toMatchObject({ cookies: 'a=1', readTimedOut: false });
  });

  it('reports not superseded when the re-read never answers', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ cookies: { s: 'old' } })
      .mockImplementationOnce(() => new Promise(() => {}));
    const auth = await readCookieAuth(read);
    const check = auth.credentialsSuperseded(auth.cookies);
    await vi.advanceTimersByTimeAsync(STORE_READ_DEADLINE_MS);
    expect(await check).toBe(false);
  });
});

describe('readAnalyticsCookieAuth', () => {
  beforeEach(() => {
    mockGetStoredAnalyticsCredentials.mockReset();
  });

  it('reads the stored analytics credentials and unwraps the cookies', async () => {
    mockGetStoredAnalyticsCredentials.mockResolvedValue({ credentials: { cookies: { s: '1' } } });
    const env = { CODEMIE_URL: 'https://x' } as NodeJS.ProcessEnv;
    const overrides = { provider: 'ai-run-sso', baseUrl: 'https://api' };

    const auth = await readAnalyticsCookieAuth('https://sso', env, overrides);

    expect(auth.cookies).toBe('s=1');
    expect(mockGetStoredAnalyticsCredentials).toHaveBeenCalledWith('https://sso', env, overrides);
  });

  it('re-runs the same read with the same arguments', async () => {
    mockGetStoredAnalyticsCredentials
      .mockResolvedValueOnce({ credentials: { cookies: { s: 'old' } } })
      .mockResolvedValueOnce({ credentials: { cookies: { s: 'new' } } });
    const env = {} as NodeJS.ProcessEnv;
    const overrides = { baseUrl: 'https://api' };

    const auth = await readAnalyticsCookieAuth('https://sso', env, overrides);
    expect(await auth.credentialsSuperseded(auth.cookies)).toBe(true);

    expect(mockGetStoredAnalyticsCredentials).toHaveBeenCalledTimes(2);
    expect(mockGetStoredAnalyticsCredentials).toHaveBeenNthCalledWith(1, 'https://sso', env, overrides);
    expect(mockGetStoredAnalyticsCredentials).toHaveBeenNthCalledWith(2, 'https://sso', env, overrides);
  });

  it('yields an empty header when no credentials are stored', async () => {
    mockGetStoredAnalyticsCredentials.mockResolvedValue(null);
    const auth = await readAnalyticsCookieAuth('https://sso', {} as NodeJS.ProcessEnv);
    expect(auth.cookies).toBe('');
  });
});

describe('diagnostics', () => {
  const logged = (): string => JSON.stringify(mockLoggerDebug.mock.calls);

  beforeEach(() => {
    mockLoggerDebug.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs a timed-out store read with the deadline and no credentials', async () => {
    vi.useFakeTimers();
    const guarded = readWithDeadline<Creds>(() => new Promise(() => {}), 50);
    const result = guarded();
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBeNull();

    expect(mockLoggerDebug).toHaveBeenCalledWith('[cookie-auth] store read timed out after 50ms');
  });

  it('does not log a timeout for a read that answers in time', async () => {
    await readWithDeadline<Creds>(async () => ({ cookies: { a: '1' } }))();

    expect(mockLoggerDebug).not.toHaveBeenCalled();
  });

  it('logs a store read that throws, without secrets from the error', async () => {
    const guarded = readWithDeadline<Creds>(async () => {
      throw new Error('keychain locked');
    });
    expect(await guarded()).toBeNull();

    expect(mockLoggerDebug).toHaveBeenCalledWith('[cookie-auth] store read failed', expect.anything());
    expect(logged()).toContain('keychain locked');
  });

  it('logs a failing supersede check and never the sent header or cookie values', async () => {
    const source = { refreshNow: vi.fn().mockRejectedValue(new Error('boom')) };
    expect(await sentCredentialsSuperseded('session=super-secret-value', source)).toBe(false);

    expect(mockLoggerDebug).toHaveBeenCalledWith('[cookie-auth] supersede check failed', expect.anything());
    expect(logged()).not.toContain('super-secret-value');
  });

  it('logs and yields an empty header when the stored credentials are malformed', async () => {
    const result = await readCookieAuth(async () => ({}) as never);

    expect(result.cookies).toBe('');
    expect(mockLoggerDebug).toHaveBeenCalledWith('[cookie-auth] stored credentials are malformed', expect.anything());
  });
});
