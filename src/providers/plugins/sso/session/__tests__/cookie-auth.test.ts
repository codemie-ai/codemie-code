import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CookieSSOAuth, SSOAuth } from '../../auth/types.js';

const mockLoggerDebug = vi.hoisted(() => vi.fn());

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: mockLoggerDebug },
}));

const {
  STORE_READ_DEADLINE_MS,
  buildCookieHeader,
  droppedCookieKeys,
  hasUsableCookies,
  readWithDeadline,
  sentCredentialsSuperseded,
  supersedingAuthValue,
  buildCookieAuth,
} = await import('../cookie-auth.js');
const { toSSOAuth } = await import('../../auth/selection.js');
type Creds = { cookies: Record<string, string> };

const API_URL = 'https://api';

/** A stored cookie login as the resolver returns it. */
function cookieAuth(cookies: Record<string, string>): CookieSSOAuth {
  return toSSOAuth({ type: 'cookie', record: { cookies, apiUrl: API_URL } }, API_URL) as CookieSSOAuth;
}

/** A stored JWT login as the resolver returns it. */
function jwtAuth(token: string): SSOAuth {
  return toSSOAuth({ type: 'jwt', record: { token, apiUrl: API_URL } }, API_URL);
}

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

describe('hasUsableCookies', () => {
  it('is true for cookies that build a header', () => {
    expect(hasUsableCookies({ a: '1' })).toBe(true);
  });

  it('is false for empty or entirely unusable cookies', () => {
    expect(hasUsableCookies({})).toBe(false);
    expect(hasUsableCookies({ 'bad\nname': 'x' })).toBe(false);
  });

  it('is false, not a throw, for a missing or malformed cookies field', () => {
    expect(hasUsableCookies(undefined)).toBe(false);
    expect(hasUsableCookies(null)).toBe(false);
    expect(hasUsableCookies('a=1')).toBe(false);
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
    const source = { refreshNow: vi.fn().mockResolvedValue(cookieAuth({ s: 'new' })) };
    expect(await sentCredentialsSuperseded('s=old', source)).toBe(true);
  });

  it('is false when headers are equal', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue(cookieAuth({ s: 'same' })) };
    expect(await sentCredentialsSuperseded('s=same', source)).toBe(false);
  });

  it('is false without a source', async () => {
    expect(await sentCredentialsSuperseded('s=old')).toBe(false);
  });

  it('is false when nothing was sent, without consulting the source', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue(cookieAuth({ s: 'new' })) };
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
    const source = { refreshNow: vi.fn().mockResolvedValue(cookieAuth({ '': 'x' })) };
    expect(await sentCredentialsSuperseded('s=old', source)).toBe(false);
  });
});

describe('supersedingAuthValue', () => {
  it('returns the stored header when it differs from the sent one', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue(cookieAuth({ s: 'new' })) };
    expect(await supersedingAuthValue('s=old', source)).toBe('s=new');
  });

  it.each([
    ['equal headers', 's=same', cookieAuth({ s: 'same' })],
    ['an empty store', 's=old', null],
    ['an unusable stored header', 's=old', cookieAuth({ '': 'x' })],
  ])('returns null for %s', async (_label, sent, stored) => {
    const source = { refreshNow: vi.fn().mockResolvedValue(stored) };
    expect(await supersedingAuthValue(sent, source)).toBeNull();
  });

  it('returns null when the re-read throws, without a source or when nothing was sent', async () => {
    expect(await supersedingAuthValue('s=old', { refreshNow: vi.fn().mockRejectedValue(new Error('boom')) })).toBeNull();
    expect(await supersedingAuthValue('s=old')).toBeNull();
    expect(await supersedingAuthValue('', { refreshNow: vi.fn() })).toBeNull();
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

describe('buildCookieAuth', () => {
  it('builds the header from the first read', async () => {
    const source = { refreshNow: vi.fn() };
    const auth = await buildCookieAuth(cookieAuth({ a: '1', b: '2' }), source, false);
    expect(auth.cookies).toBe(buildCookieHeader({ a: '1', b: '2' }));
    expect(source.refreshNow).not.toHaveBeenCalled();
  });

  it('passes the read deadline outcome through', async () => {
    const source = { refreshNow: vi.fn() };
    expect(await buildCookieAuth(cookieAuth({ a: '1' }), source, true)).toMatchObject({ readTimedOut: true });
    expect(await buildCookieAuth(cookieAuth({ a: '1' }), source, false)).toMatchObject({ readTimedOut: false });
  });

  it('reports superseded when the source re-read differs', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue(cookieAuth({ s: 'new' })) };
    const auth = await buildCookieAuth(cookieAuth({ s: 'old' }), source, false);
    expect(await auth.credentialsSuperseded(auth.cookies)).toBe(true);
    expect(source.refreshNow).toHaveBeenCalledTimes(1);
  });

  it('reports not superseded when the source re-read is equal', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue(cookieAuth({ s: 'same' })) };
    const auth = await buildCookieAuth(cookieAuth({ s: 'same' }), source, false);
    expect(await auth.credentialsSuperseded(auth.cookies)).toBe(false);
  });

  it('reports not superseded when the source re-read is null', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue(null) };
    const auth = await buildCookieAuth(cookieAuth({ s: 'old' }), source, false);
    expect(await auth.credentialsSuperseded(auth.cookies)).toBe(false);
  });
});

describe('supersede across credential types', () => {
  // Deliberate behaviour change: a JWT sign-in now supersedes a sent Cookie header (and vice
  // versa); the comparison is on the auth value, whatever the type.
  it('reports a cookie header superseded by a JWT sign-in', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue(jwtAuth('jwt')) };
    expect(await sentCredentialsSuperseded('s=old', source)).toBe(true);
    expect(await supersedingAuthValue('s=old', source)).toBe('jwt');
  });

  it('reports a sent token superseded by a cookie sign-in', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue(cookieAuth({ s: 'new' })) };
    expect(await sentCredentialsSuperseded('jwt', source)).toBe(true);
  });

  it('reports a sent token not superseded by the same token', async () => {
    const source = { refreshNow: vi.fn().mockResolvedValue(jwtAuth('jwt')) };
    expect(await sentCredentialsSuperseded('jwt', source)).toBe(false);
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
});
