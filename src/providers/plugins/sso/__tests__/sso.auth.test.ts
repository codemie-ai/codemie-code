/**
 * Tests for deriveExpiresAt — JWT exp extraction from cookie dict.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('open', () => ({ default: vi.fn() }));
vi.mock('@/utils/analytics-auth-status.js', () => ({ clearAnalyticsAuthStatus: vi.fn() }));
vi.mock('@/providers/core/credential-owner.js', () => ({ withVerifiedOwner: vi.fn() }));

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
