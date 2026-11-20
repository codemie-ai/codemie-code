/**
 * Tests for CodeMieSSO: login storage through the SSO auth resolver, and callback parsing.
 * (recordExpiresAt, formerly effectiveExpiresAt, is covered in auth/__tests__/selection.test.ts.)
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  retrieveSSOCredentials,
  clearSSOCredentials,
  storeSSOCredentials,
  storeJWTCredentials,
  clearJWTCredentials,
  retrieveJWTCredentials,
  fetchCodeMieUserInfo,
} = vi.hoisted(() => ({
  retrieveSSOCredentials: vi.fn(),
  clearSSOCredentials: vi.fn(),
  storeSSOCredentials: vi.fn(),
  storeJWTCredentials: vi.fn(),
  clearJWTCredentials: vi.fn(),
  retrieveJWTCredentials: vi.fn(),
  fetchCodeMieUserInfo: vi.fn(),
}));

vi.mock('@/utils/security.js', () => ({
  CredentialStore: {
    getInstance: () => ({
      retrieveSSOCredentials,
      clearSSOCredentials,
      storeSSOCredentials,
      storeJWTCredentials,
      clearJWTCredentials,
      retrieveJWTCredentials,
    }),
  },
}));
// The login-time cookie check (cookie strategy isAccepted) must not reach the network.
vi.mock('@/providers/core/codemie-auth-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/core/codemie-auth-helpers.js')>()),
  fetchCodeMieUserInfo,
}));
vi.mock('open', () => ({ default: vi.fn() }));
vi.mock('@/utils/analytics-auth-status.js', () => ({ clearAnalyticsAuthStatus: vi.fn() }));
vi.mock('@/providers/core/credential-owner.js', () => ({ withVerifiedOwner: vi.fn() }));

import { deriveExpiresAt, CodeMieSSO } from '../sso.auth.js';
import { resolveSSOAuthForUrl } from '../auth/index.js';

beforeEach(() => {
  retrieveSSOCredentials.mockReset().mockResolvedValue(null);
  retrieveJWTCredentials.mockReset().mockResolvedValue(null);
  fetchCodeMieUserInfo.mockReset().mockResolvedValue({ email: 'u@test.com' });
});

function makeJwt(exp: number): string {
  const payload = { sub: 'uid', email: 'u@test.com', exp, iss: 'codemie-local' };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJSUzI1NiJ9.${b64}.fakesig`;
}

describe('deriveExpiresAt', () => {
  it('returns JWT exp * 1000 when codemie_access_token is a valid JWT with exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 1 week
    const jwt = makeJwt(exp);

    const result = deriveExpiresAt({ codemie_access_token: jwt });

    expect(result).toBe(exp * 1000);
  });

  it('returns undefined when codemie_access_token is malformed', () => {
    expect(deriveExpiresAt({ codemie_access_token: 'not.a.valid.jwt.at.all' })).toBeUndefined();
  });

  // Chosen behaviour (EPMCDME-17014): a token whose expiry cannot be read gets no local expiry rather
  // than an invented one; only the server's rejection ends such a session.
  it.each([
    ['a JWT without an exp claim', `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: 'uid' })).toString('base64url')}.sig`],
    ['a JWT with a non-numeric exp', `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: 'soon' })).toString('base64url')}.sig`],
    ['a JWT whose payload is not JSON', 'eyJhbGciOiJSUzI1NiJ9.bm90LWpzb24.sig'],
    ['a token with too few parts', 'opaque-token'],
  ])('returns no expiry for %s, not a synthetic 24 h', (_label, token) => {
    expect(deriveExpiresAt({ codemie_access_token: token })).toBeUndefined();
  });

  it('returns undefined when codemie_access_token cookie is absent', () => {
    expect(deriveExpiresAt({})).toBeUndefined();
    expect(deriveExpiresAt({ _oauth2_proxy: 'abc' })).toBeUndefined();
  });
});

describe('resolveSSOAuthForUrl (formerly CodeMieSSO.getStoredCredentials)', () => {
  const url = 'https://codemie.example.com';
  beforeEach(() => {
    clearSSOCredentials.mockReset();
  });

  it('returns cookie-only credentials stored over 24h ago without clearing them', async () => {
    const stale = Date.now() - (24 * 60 * 60 * 1000 + 60 * 1000);
    const creds = { cookies: { _oauth2_proxy: 'x' }, apiUrl: url, expiresAt: stale };
    retrieveSSOCredentials.mockResolvedValue(creds);

    const result = await resolveSSOAuthForUrl(url);

    expect(result).toMatchObject({ type: 'cookie', apiUrl: url });
    expect(result?.type === 'cookie' && result.cookies).toBe(creds.cookies);
    expect(clearSSOCredentials).not.toHaveBeenCalled();
  });

  it('keeps a credential whose codemie_access_token has no readable exp: only the server ends such a session', async () => {
    const creds = { cookies: { codemie_access_token: 'opaque-token' }, apiUrl: url }; // no expiresAt: none could be derived
    retrieveSSOCredentials.mockResolvedValue(creds);

    const result = await resolveSSOAuthForUrl(url);

    expect(result).toMatchObject({ type: 'cookie', apiUrl: url });
    expect(result?.type === 'cookie' && result.cookies).toBe(creds.cookies);
    expect(clearSSOCredentials).not.toHaveBeenCalled();
  });

  it('clears and returns null for JWT-bearing credentials past their exp', async () => {
    const creds = {
      cookies: { codemie_access_token: makeJwt(Math.floor(Date.now() / 1000) - 60) },
      apiUrl: url,
      expiresAt: Date.now() - 60 * 1000,
    };
    retrieveSSOCredentials.mockResolvedValue(creds);

    const result = await resolveSSOAuthForUrl(url);

    expect(result).toBeNull();
    expect(clearSSOCredentials).toHaveBeenCalledWith(url);
  });
});

describe('CodeMieSSO.authenticate storage', () => {
  it('stores no expiresAt when the callback carries only _oauth2_proxy', async () => {
    storeSSOCredentials.mockReset();
    const sso = new CodeMieSSO();
    vi.spyOn(sso as never, 'startLocalServer').mockResolvedValue(1234 as never);
    vi.spyOn(sso as never, 'waitForCallback').mockResolvedValue({
      success: true,
      apiUrl: 'https://codemie.example.com/code-assistant-api',
      cookies: { _oauth2_proxy: 'x' },
    } as never);

    const result = await sso.authenticate({ codeMieUrl: 'https://codemie.example.com', quiet: true });

    expect(result.success).toBe(true);
    expect(storeSSOCredentials).toHaveBeenCalledTimes(1);
    const stored = storeSSOCredentials.mock.calls[0][0];
    expect(stored).not.toHaveProperty('expiresAt');
  });
});

describe('CodeMieSSO.authenticate storage — JWT fallback', () => {
  const codeMieUrl = 'https://codemie.example.com';
  const apiUrl = `${codeMieUrl}/code-assistant-api`;

  beforeEach(() => {
    storeSSOCredentials.mockReset();
    storeJWTCredentials.mockReset();
  });

  async function authenticateWith(result: Record<string, unknown>) {
    const sso = new CodeMieSSO();
    vi.spyOn(sso as never, 'startLocalServer').mockResolvedValue(1234 as never);
    vi.spyOn(sso as never, 'waitForCallback').mockResolvedValue({ success: true, apiUrl, ...result } as never);
    return sso.authenticate({ codeMieUrl, quiet: true });
  }

  it('stores the JWT with its exp when the callback carries no cookies', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeJwt(exp);

    await authenticateWith({ cookies: {}, jwt });

    expect(storeSSOCredentials).not.toHaveBeenCalled();
    expect(storeJWTCredentials).toHaveBeenCalledWith(
      { token: jwt, apiUrl, expiresAt: exp * 1000, authType: 'jwt', storedAt: expect.any(Number) },
      codeMieUrl,
    );
  });

  it('stores no expiresAt for a JWT without a readable exp', async () => {
    await authenticateWith({ jwt: 'opaque-token' });

    expect(storeJWTCredentials).toHaveBeenCalledTimes(1);
    expect(storeJWTCredentials.mock.calls[0][0]).not.toHaveProperty('expiresAt');
  });

  it('stores the cookies, not the JWT, when the callback carries both', async () => {
    await authenticateWith({ cookies: { _oauth2_proxy: 'x' }, jwt: 'opaque-token' });

    expect(storeSSOCredentials).toHaveBeenCalledTimes(1);
    expect(storeJWTCredentials).not.toHaveBeenCalled();
  });

  it('unusable cookies fall back to jwt', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const parser = new CodeMieSSO();
      (parser as unknown as { codeMieUrl: string }).codeMieUrl = codeMieUrl;
      const token = Buffer.from(JSON.stringify({ cookies: { '': 'x', session: 'v\u0007' }, authorization: 'Bearer abc.def.ghi' })).toString('base64');
      const parsed = await (parser as unknown as { handleCallback(u: URL): Promise<Record<string, unknown>> })
        .handleCallback(new URL(`http://localhost:1234/?token=${encodeURIComponent(token)}`));

      const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(init.headers).toEqual({ authorization: 'Bearer abc.def.ghi' });
      expect(parsed).toMatchObject({ success: true, jwt: 'abc.def.ghi' });
      expect(parsed).not.toHaveProperty('cookies');

      const { success: _success, ...rest } = parsed;
      await authenticateWith(rest);

      expect(storeSSOCredentials).not.toHaveBeenCalled();
      expect(storeJWTCredentials).toHaveBeenCalledWith(expect.objectContaining({ token: 'abc.def.ghi', authType: 'jwt' }), codeMieUrl);
      expect(fetchCodeMieUserInfo).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('CodeMieSSO.clearStoredCredentials', () => {
  it('clears both the SSO cookie slot and the JWT slot', async () => {
    clearSSOCredentials.mockReset();
    clearJWTCredentials.mockReset();

    await new CodeMieSSO().clearStoredCredentials('https://codemie.example.com');

    expect(clearSSOCredentials).toHaveBeenCalledWith('https://codemie.example.com');
    expect(clearJWTCredentials).toHaveBeenCalledWith('https://codemie.example.com');
  });
});

describe('CodeMieSSO callback parsing', () => {
  const codeMieUrl = 'https://codemie.example.com';
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function callback(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sso = new CodeMieSSO();
    (sso as unknown as { codeMieUrl: string }).codeMieUrl = codeMieUrl;
    const token = Buffer.from(JSON.stringify(payload)).toString('base64');
    const url = new URL(`http://localhost:1234/?token=${encodeURIComponent(token)}`);
    return (sso as unknown as { handleCallback(u: URL): Promise<Record<string, unknown>> }).handleCallback(url);
  }

  it.each([['Bearer abc.def.ghi'], ['bearer abc.def.ghi'], ['  BEARER   abc.def.ghi  '], ['abc.def.ghi']])(
    'takes the raw JWT from an authorization field of %j',
    async (authorization) => {
      const result = await callback({ authorization });
      expect(result).toMatchObject({ success: true, jwt: 'abc.def.ghi' });
    }
  );

  it('authenticates the config.js lookup with the JWT when there are no cookies', async () => {
    await callback({ cookies: {}, authorization: 'Bearer abc.def.ghi' });

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).toEqual({ authorization: 'Bearer abc.def.ghi' });
  });

  it('authenticates the config.js lookup with cookies when present, and returns no jwt', async () => {
    const result = await callback({ cookies: { a: '1', b: '2' } });

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers).toEqual({ cookie: 'a=1; b=2' });
    expect(result).toMatchObject({ success: true, cookies: { a: '1', b: '2' } });
    expect(result).not.toHaveProperty('jwt');
  });

  it('fails when the payload carries neither cookies nor an authorization field', async () => {
    const result = await callback({ cookies: {}, authorization: '   ' });

    expect(result).toEqual({ success: false, error: 'Token missing cookies and authorization fields' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
