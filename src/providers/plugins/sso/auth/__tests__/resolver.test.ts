/**
 * Tests for the SSO auth resolver over an in-memory CredentialStore.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveLegacyUrlStorageKey, deriveUrlStorageKey } from '@/utils/credential-crypto.js';
import { ConfigurationError } from '@/utils/errors.js';
import { ProviderName } from '@/providers/core/types.js';

const { slots, fetchCodeMieUserInfo } = vi.hoisted(() => ({
  slots: new Map<string, unknown>(),
  fetchCodeMieUserInfo: vi.fn(),
}));

/**
 * Mirrors CredentialStore's key layout: cookie records under `deriveUrlStorageKey(url)` (legacy:
 * `deriveLegacyUrlStorageKey(url)`, migrated on first read), JWT records under the same keys with a
 * `jwt-` prefix, and one global slot per type (`sso-credentials`, `jwt-credentials`).
 */
vi.mock('@/utils/security.js', async () => {
  const crypto = await import('@/utils/credential-crypto.js');

  function read<T>(current: string, legacy: string | undefined, migrate: boolean): T | null {
    if (slots.has(current)) return slots.get(current) as T;
    if (legacy && legacy !== current && slots.has(legacy)) {
      const value = slots.get(legacy) as T;
      if (migrate) {
        slots.set(current, value);
        slots.delete(legacy);
      }
      return value;
    }
    return null;
  }

  const store = {
    async storeSSOCredentials(credentials: unknown, baseUrl?: string): Promise<void> {
      slots.set(baseUrl ? crypto.deriveUrlStorageKey(baseUrl) : 'sso-credentials', credentials);
    },
    async retrieveSSOCredentials(baseUrl?: string): Promise<unknown> {
      if (!baseUrl) return slots.get('sso-credentials') ?? null;
      return read(crypto.deriveUrlStorageKey(baseUrl), crypto.deriveLegacyUrlStorageKey(baseUrl), true);
    },
    async clearSSOCredentials(baseUrl?: string): Promise<void> {
      if (!baseUrl) {
        slots.delete('sso-credentials');
        return;
      }
      slots.delete(crypto.deriveUrlStorageKey(baseUrl));
      slots.delete(crypto.deriveLegacyUrlStorageKey(baseUrl));
    },
    async storeJWTCredentials(credentials: unknown, baseUrl?: string): Promise<void> {
      slots.set(baseUrl ? `jwt-${crypto.deriveUrlStorageKey(baseUrl)}` : 'jwt-credentials', credentials);
    },
    async retrieveJWTCredentials(
      baseUrl?: string,
      opts: { includeExpired?: boolean } = {},
    ): Promise<{ expiresAt?: number } | null> {
      const record = baseUrl
        ? read<{ expiresAt?: number }>(
          `jwt-${crypto.deriveUrlStorageKey(baseUrl)}`,
          `jwt-${crypto.deriveLegacyUrlStorageKey(baseUrl)}`,
          true,
        )
        : ((slots.get('jwt-credentials') as { expiresAt?: number } | undefined) ?? null);
      if (!record) return null;
      if (!opts.includeExpired && record.expiresAt && Date.now() > record.expiresAt) return null;
      return record;
    },
    async clearJWTCredentials(baseUrl?: string): Promise<void> {
      if (!baseUrl) {
        slots.delete('jwt-credentials');
        return;
      }
      slots.delete(`jwt-${crypto.deriveUrlStorageKey(baseUrl)}`);
      slots.delete(`jwt-${crypto.deriveLegacyUrlStorageKey(baseUrl)}`);
    },
  };

  return { CredentialStore: { getInstance: () => store } };
});

vi.mock('@/providers/core/codemie-auth-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/providers/core/codemie-auth-helpers.js')>()),
  fetchCodeMieUserInfo,
}));

const { storeSSOAuth, resolveSSOAuthForUrl, resolveSSOAuth } = await import('../resolver.js');

const host = 'https://codemie.example.com';
const apiUrl = `${host}/code-assistant-api`;
/** A URL with a path, so its legacy (raw-URL) key differs from its normalized key. */
const urlWithPath = `${host}/app`;

const cookieKey = (url: string): string => deriveUrlStorageKey(url);
const legacyCookieKey = (url: string): string => deriveLegacyUrlStorageKey(url);
const jwtKey = (url: string): string => `jwt-${deriveUrlStorageKey(url)}`;

function makeJwt(exp: number): string {
  const b64 = Buffer.from(JSON.stringify({ sub: 'uid', exp })).toString('base64url');
  return `eyJhbGciOiJSUzI1NiJ9.${b64}.fakesig`;
}

beforeEach(() => {
  slots.clear();
  fetchCodeMieUserInfo.mockReset();
  fetchCodeMieUserInfo.mockResolvedValue({ email: 'u@test.com' });
});

describe('storeSSOAuth', () => {
  it('cookie callback saves only cookies and clears jwt', async () => {
    slots.set(jwtKey(host), { token: 'old', apiUrl });

    const auth = await storeSSOAuth({ success: true, apiUrl, cookies: { a: '1' }, jwt: 't' }, host);

    expect(auth?.type).toBe('cookie');
    expect(slots.get(cookieKey(host))).toMatchObject({
      cookies: { a: '1' },
      apiUrl,
      authType: 'cookie',
      storedAt: expect.any(Number),
    });
    expect(slots.has(jwtKey(host))).toBe(false);
    expect(fetchCodeMieUserInfo).toHaveBeenCalledWith(apiUrl, { a: '1' }, expect.objectContaining({ followRedirects: false }));
  });

  it('stores the jwt when the server rejects the callback cookies', async () => {
    fetchCodeMieUserInfo.mockRejectedValue(new ConfigurationError('redirected to login'));

    const auth = await storeSSOAuth({ success: true, apiUrl, cookies: { a: '1' }, jwt: 't' }, host);

    expect(auth?.type).toBe('jwt');
    expect(slots.get(jwtKey(host))).toMatchObject({ token: 't', apiUrl, authType: 'jwt' });
    expect(slots.has(cookieKey(host))).toBe(false);
  });

  it('keeps the cookies when the login-time check fails on the network', async () => {
    fetchCodeMieUserInfo.mockRejectedValue(new Error('ECONNRESET'));

    const auth = await storeSSOAuth({ success: true, apiUrl, cookies: { a: '1' }, jwt: 't' }, host);

    expect(auth?.type).toBe('cookie');
    expect(slots.has(jwtKey(host))).toBe(false);
  });

  it('does not check a callback that carries only cookies', async () => {
    await storeSSOAuth({ success: true, apiUrl, cookies: { a: '1' } }, host);

    expect(fetchCodeMieUserInfo).not.toHaveBeenCalled();
    expect(slots.has(cookieKey(host))).toBe(true);
  });

  describe('jwt login clears every cookie key for the host', () => {
    it('clears the current key, the legacy key and a same-origin global slot', async () => {
      expect(legacyCookieKey(urlWithPath)).not.toBe(cookieKey(urlWithPath));
      slots.set(cookieKey(urlWithPath), { cookies: { a: 'current' }, apiUrl });
      slots.set(legacyCookieKey(urlWithPath), { cookies: { a: 'legacy' }, apiUrl });
      slots.set('sso-credentials', { cookies: { a: 'global' }, apiUrl });

      const auth = await storeSSOAuth({ success: true, apiUrl, jwt: 't' }, urlWithPath);

      expect(auth?.type).toBe('jwt');
      expect(slots.get(jwtKey(urlWithPath))).toMatchObject({ token: 't', authType: 'jwt' });
      expect(slots.has(cookieKey(urlWithPath))).toBe(false);
      expect(slots.has(legacyCookieKey(urlWithPath))).toBe(false);
      expect(slots.has('sso-credentials')).toBe(false);
    });

    it('leaves a different-origin global slot untouched', async () => {
      const other = { cookies: { a: 'other' }, apiUrl: 'https://other.example.com/code-assistant-api' };
      slots.set('sso-credentials', other);

      await storeSSOAuth({ success: true, apiUrl, jwt: 't' }, host);

      expect(slots.get('sso-credentials')).toBe(other);
    });
  });

  it('returns null and stores nothing when the payload has no usable material', async () => {
    const auth = await storeSSOAuth({ success: true, apiUrl, cookies: { '': 'x' } }, host);

    expect(auth).toBeNull();
    expect(slots.size).toBe(0);
  });
});

describe('resolveSSOAuthForUrl', () => {
  it('expired jwt is cleared on read', async () => {
    slots.set(jwtKey(host), { token: makeJwt(1), apiUrl, expiresAt: Date.now() - 60_000 });

    const auth = await resolveSSOAuthForUrl(host);

    expect(auth).toBeNull();
    expect(slots.has(jwtKey(host))).toBe(false);
  });

  it('clears only the expired type, and falls back to the live other type', async () => {
    slots.set(jwtKey(host), { token: 'expired', apiUrl, expiresAt: Date.now() - 60_000 });
    slots.set(cookieKey(host), { cookies: { a: '1' }, apiUrl });

    const auth = await resolveSSOAuthForUrl(host);

    expect(auth?.type).toBe('cookie');
    expect(slots.has(jwtKey(host))).toBe(false);
    expect(slots.has(cookieKey(host))).toBe(true);
  });

  it('uses a same-origin global jwt when the URL has none of its own', async () => {
    slots.set('jwt-credentials', { token: 't', apiUrl });

    const auth = await resolveSSOAuthForUrl(host);

    expect(auth).toMatchObject({ type: 'jwt', headers: { authorization: 'Bearer t' } });
  });

  it('ignores a different-origin global jwt', async () => {
    slots.set('jwt-credentials', { token: 't', apiUrl: 'https://other.example.com' });

    expect(await resolveSSOAuthForUrl(host)).toBeNull();
  });
});

describe('resolveSSOAuth', () => {
  const prod = 'https://prod.example.com';
  const dev = 'https://dev.example.com';
  const src = { provider: ProviderName.AI_RUN_SSO, baseUrl: prod, codeMieUrl: dev };

  it('profile-origin filtering applies to jwt too', async () => {
    slots.set(jwtKey(dev), { token: 'dev-token', apiUrl: `${dev}/code-assistant-api` });

    expect(await resolveSSOAuth(src)).toBeNull();
  });

  it('accepts a jwt under the fallback URL when it was issued for the profile host', async () => {
    slots.set(jwtKey(dev), { token: 'prod-token', apiUrl: `${prod}/code-assistant-api` });

    const auth = await resolveSSOAuth(src);

    expect(auth).toMatchObject({ type: 'jwt', token: 'prod-token' });
  });

  it('prefers the profile URL record', async () => {
    slots.set(jwtKey(prod), { token: 'prod-token', apiUrl: `${prod}/code-assistant-api` });
    slots.set(jwtKey(dev), { token: 'dev-token', apiUrl: `${dev}/code-assistant-api` });

    expect(await resolveSSOAuth(src)).toMatchObject({ type: 'jwt', token: 'prod-token' });
  });
});
