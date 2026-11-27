/**
 * Tests for deriveExpiresAt — JWT exp extraction from cookie dict.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { retrieveSSOCredentials, clearSSOCredentials, storeSSOCredentials } = vi.hoisted(() => ({
  retrieveSSOCredentials: vi.fn(),
  clearSSOCredentials: vi.fn(),
  storeSSOCredentials: vi.fn(),
}));

vi.mock('@/utils/security.js', () => ({
  CredentialStore: {
    getInstance: () => ({ retrieveSSOCredentials, clearSSOCredentials, storeSSOCredentials }),
  },
}));
vi.mock('open', () => ({ default: (...a: unknown[]) => openMock(...a) }));
vi.mock('@/utils/analytics-auth-status.js', () => ({ clearAnalyticsAuthStatus: vi.fn() }));
vi.mock('@/providers/core/credential-owner.js', () => ({ withVerifiedOwner: vi.fn() }));

const { promptForPastedToken, openMock } = vi.hoisted(() => ({
  promptForPastedToken: vi.fn(),
  openMock: vi.fn(),
}));
vi.mock('../sso.paste-prompt.js', () => ({ promptForPastedToken }));

import { deriveExpiresAt, effectiveExpiresAt, CodeMieSSO } from '../sso.auth.js';

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

describe('effectiveExpiresAt', () => {
  it('is undefined for cookie-only credentials, even with a legacy synthetic expiresAt', () => {
    expect(effectiveExpiresAt({ cookies: { _oauth2_proxy: 'x' } })).toBeUndefined();
    expect(effectiveExpiresAt({ cookies: { _oauth2_proxy: 'x' }, expiresAt: Date.now() - 1000 })).toBeUndefined();
  });

  it('has no local expiry for an exp-less codemie_access_token whose stored expiresAt is unset', () => {
    expect(effectiveExpiresAt({ cookies: { codemie_access_token: 'opaque-token' } })).toBeUndefined();
  });

  it('returns the stored expiresAt when codemie_access_token is present', () => {
    const exp = Date.now() + 1000;
    expect(effectiveExpiresAt({ cookies: { codemie_access_token: makeJwt(1) }, expiresAt: exp })).toBe(exp);
  });
});

describe('CodeMieSSO.getStoredCredentials', () => {
  const url = 'https://codemie.example.com';
  beforeEach(() => {
    retrieveSSOCredentials.mockReset();
    clearSSOCredentials.mockReset();
  });

  it('returns cookie-only credentials stored over 24h ago without clearing them', async () => {
    const stale = Date.now() - (24 * 60 * 60 * 1000 + 60 * 1000);
    const creds = { cookies: { _oauth2_proxy: 'x' }, apiUrl: url, expiresAt: stale };
    retrieveSSOCredentials.mockResolvedValue(creds);

    const result = await new CodeMieSSO().getStoredCredentials(url);

    expect(result).toBe(creds);
    expect(clearSSOCredentials).not.toHaveBeenCalled();
  });

  it('keeps a credential whose codemie_access_token has no readable exp: only the server ends such a session', async () => {
    const creds = { cookies: { codemie_access_token: 'opaque-token' }, apiUrl: url }; // no expiresAt: none could be derived
    retrieveSSOCredentials.mockResolvedValue(creds);

    const result = await new CodeMieSSO().getStoredCredentials(url);

    expect(result).toBe(creds);
    expect(clearSSOCredentials).not.toHaveBeenCalled();
  });

  it('clears and returns null for JWT-bearing credentials past their exp', async () => {
    const creds = {
      cookies: { codemie_access_token: makeJwt(Math.floor(Date.now() / 1000) - 60) },
      apiUrl: url,
      expiresAt: Date.now() - 60 * 1000,
    };
    retrieveSSOCredentials.mockResolvedValue(creds);

    const result = await new CodeMieSSO().getStoredCredentials(url);

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

describe('CodeMieSSO.authenticate headless', () => {
  const validToken = Buffer.from(JSON.stringify({ cookies: { _oauth2_proxy: 'x' } })).toString('base64');
  beforeEach(() => {
    storeSSOCredentials.mockReset();
    promptForPastedToken.mockReset();
    openMock.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('stores credentials from a pasted token without starting a server or opening a browser', async () => {
    promptForPastedToken.mockResolvedValue(validToken);
    const sso = new CodeMieSSO();
    const server = vi.spyOn(sso as never, 'startLocalServer');

    const result = await sso.authenticate({ codeMieUrl: 'https://codemie.example.com', headless: true });

    expect(result.success).toBe(true);
    expect(server).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
    expect(storeSSOCredentials).toHaveBeenCalledTimes(1);
  });

  it('prints the login URL even when quiet', async () => {
    promptForPastedToken.mockResolvedValue(validToken);
    await new CodeMieSSO().authenticate({ codeMieUrl: 'https://codemie.example.com', headless: true, quiet: true });
    const out = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0])).join('\n');
    expect(out).toContain('https://codemie.example.com/code-assistant-api/v1/auth/login/');
  });

  it('retries bad pastes up to 3 times, then fails with nothing stored and no input echoed', async () => {
    promptForPastedToken.mockResolvedValue('garbage-input');
    const result = await new CodeMieSSO().authenticate({ codeMieUrl: 'https://codemie.example.com', headless: true });
    expect(result.success).toBe(false);
    expect(promptForPastedToken).toHaveBeenCalledTimes(3);
    expect(storeSSOCredentials).not.toHaveBeenCalled();
    expect(result.error).not.toContain('garbage-input');
  });

  it('reports cancellation when the prompt aborts', async () => {
    promptForPastedToken.mockRejectedValue(Object.assign(new Error('x'), { name: 'AbortError' }));
    const result = await new CodeMieSSO().authenticate({ codeMieUrl: 'https://codemie.example.com', headless: true });
    expect(result).toEqual({ success: false, error: 'Authentication cancelled by user' });
  });
});

describe('CodeMieSSO browser callback', () => {
  const BASE = 'https://codemie.example.com';
  const cookies = { _oauth2_proxy: 'x' };
  const token = Buffer.from(JSON.stringify({ cookies })).toString('base64');
  type CallbackHandler = { codeMieUrl: string; handleCallback(url: URL): Promise<Record<string, unknown>> };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a ?token= callback URL into apiUrl and cookies', async () => {
    const sso = new CodeMieSSO() as unknown as CallbackHandler;
    sso.codeMieUrl = BASE;
    const result = await sso.handleCallback(new URL(`http://localhost:1234/?token=${encodeURIComponent(token)}`));
    expect(result).toEqual({ success: true, apiUrl: `${BASE}/code-assistant-api`, cookies });
  });

  it('reports a callback without a token as a failure', async () => {
    const sso = new CodeMieSSO() as unknown as CallbackHandler;
    sso.codeMieUrl = BASE;
    const result = await sso.handleCallback(new URL('http://localhost:1234/?foo=bar'));
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
  });
});

describe('CodeMieSSO headless hardening', () => {
  const validToken = Buffer.from(JSON.stringify({ cookies: { _oauth2_proxy: 'x' } })).toString('base64');
  beforeEach(() => {
    storeSSOCredentials.mockReset();
    promptForPastedToken.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stores the VITE_API_URL from config.js, not the default API base', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'VITE_API_URL: "https://api.override.example.com/v2/"',
    }));
    promptForPastedToken.mockResolvedValue(validToken);

    await new CodeMieSSO().authenticate({ codeMieUrl: 'https://codemie.example.com', headless: true });

    expect(storeSSOCredentials).toHaveBeenCalledTimes(1);
    const [stored] = storeSSOCredentials.mock.calls[0];
    expect(stored.apiUrl).toBe('https://api.override.example.com/v2');
  });

  it('rejects headless combined with quiet and never prompts', async () => {
    const result = await new CodeMieSSO().authenticate({
      codeMieUrl: 'https://codemie.example.com',
      headless: true,
      quiet: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('quiet');
    expect(promptForPastedToken).not.toHaveBeenCalled();
    expect(storeSSOCredentials).not.toHaveBeenCalled();
  });
});
