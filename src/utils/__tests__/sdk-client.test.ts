import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfigLoad = vi.fn();
const mockCodeMieClient = vi.fn();
const mockRetrieveSSOCredentials = vi.fn();
const mockClearSSOCredentials = vi.fn();
const mockRetrieveJWTCredentials = vi.fn();

vi.mock('ora', () => ({ default: () => ({ start: () => ({ text: '', succeed: vi.fn(), fail: vi.fn() }) }) }));
vi.mock('codemie-sdk', () => ({
  CodeMieClient: class {
    constructor(opts: unknown) {
      mockCodeMieClient(opts);
    }
  },
}));
vi.mock('../config.js', () => ({ ConfigLoader: { load: () => mockConfigLoad() } }));
vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../security.js')>()),
  CredentialStore: {
    getInstance: () => ({
      retrieveSSOCredentials: (...args: unknown[]) => mockRetrieveSSOCredentials(...args),
      clearSSOCredentials: (...args: unknown[]) => mockClearSSOCredentials(...args),
      retrieveJWTCredentials: (...args: unknown[]) => mockRetrieveJWTCredentials(...args),
    }),
  },
}));
import { getCodemieClient } from '../sdk-client.js';
import { getAuthenticatedClient } from '../auth.js';

const P = 'https://profile.example.com';
const W = 'https://workspace.example.com';
const creds = { cookies: { session: 'abc' }, apiUrl: `${P}/code-assistant-api` };

/** Seeds the per-URL cookie slot; the global slot (read without a URL) stays empty. */
function seedCookies(byUrl: Record<string, unknown>): void {
  mockRetrieveSSOCredentials.mockImplementation(async (url?: string) => (url ? byUrl[url] ?? null : null));
}

/** The URLs the resolver asked the cookie slot for, in order (global-slot reads carry no URL). */
function cookieLookupUrls(): unknown[] {
  return mockRetrieveSSOCredentials.mock.calls.map(c => c[0]).filter(Boolean);
}

describe('getCodemieClient credential lookup', () => {
  beforeEach(() => {
    mockConfigLoad.mockReset();
    mockCodeMieClient.mockReset();
    mockRetrieveSSOCredentials.mockReset();
    mockClearSSOCredentials.mockReset();
    mockRetrieveJWTCredentials.mockReset();
    mockRetrieveJWTCredentials.mockResolvedValue(null);
  });

  it('finds credentials via the profile baseUrl for a baseUrl-only SSO profile', async () => {
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P });
    seedCookies({ [P]: creds });

    await getCodemieClient(true);

    expect(mockRetrieveSSOCredentials).toHaveBeenCalledWith(P);
    expect(mockCodeMieClient).toHaveBeenCalledWith(expect.objectContaining({ codemie_api_domain: creds.apiUrl }));
  });

  it('falls back to codeMieUrl when the baseUrl lookup misses', async () => {
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
    seedCookies({ [W]: creds });

    await getCodemieClient(true);

    expect(cookieLookupUrls()).toEqual([P, W]);
    expect(mockCodeMieClient).toHaveBeenCalled();
  });

  it('throws when no credentials are found under any candidate', async () => {
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
    seedCookies({});

    await expect(getCodemieClient(true)).rejects.toThrow('SSO authentication required');
  });

  it('builds the client with jwt_token when only a stored JWT exists', async () => {
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
    seedCookies({});
    // Issued for the profile's own API host, stored under the workspace URL fallback
    const jwt = { token: 'jwt-token', apiUrl: `${P}/code-assistant-api` };
    mockRetrieveJWTCredentials.mockImplementation(async (url: string) => (url === W ? jwt : null));

    await getCodemieClient(true);

    const opts = mockCodeMieClient.mock.calls[0][0];
    expect(opts).toMatchObject({ codemie_api_domain: jwt.apiUrl, jwt_token: 'jwt-token' });
    expect(opts).not.toHaveProperty('cookies');
  });

  it('prefers usable SSO cookies over a stored JWT', async () => {
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P });
    seedCookies({ [P]: creds });
    mockRetrieveJWTCredentials.mockResolvedValue({ token: 'jwt-token', apiUrl: creds.apiUrl });

    await getCodemieClient(true);

    const opts = mockCodeMieClient.mock.calls[0][0];
    expect(opts).toMatchObject({ cookies: creds.cookies });
    expect(opts).not.toHaveProperty('jwt_token');
  });

  it('creates the client for a stale cookie-only credential without clearing it', async () => {
    const stale = {
      cookies: { _oauth2_proxy: 'cookie-value' },
      apiUrl: `${P}/code-assistant-api`,
      expiresAt: Date.now() - 60_000,
    };
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P });
    mockRetrieveSSOCredentials.mockResolvedValue(stale);

    await getCodemieClient(true);

    expect(mockClearSSOCredentials).not.toHaveBeenCalled();
    expect(mockCodeMieClient).toHaveBeenCalledWith(
      expect.objectContaining({ codemie_api_domain: stale.apiUrl, cookies: stale.cookies })
    );
  });

  it('loads a stale cookie-only credential on the assistants-chat path without clearing it', async () => {
    const stale = {
      cookies: { _oauth2_proxy: 'cookie-value' },
      apiUrl: `${P}/code-assistant-api`,
      expiresAt: Date.now() - (24 * 60 * 60 * 1000 + 60_000),
    };
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P });
    mockRetrieveSSOCredentials.mockResolvedValue(stale);

    // assistants chat obtains its client through getAuthenticatedClient (non-JWT branch).
    await getAuthenticatedClient({ provider: 'ai-run-sso', baseUrl: P } as never, { nonInteractive: true });

    expect(mockClearSSOCredentials).not.toHaveBeenCalled();
    expect(mockCodeMieClient).toHaveBeenCalledWith(
      expect.objectContaining({ codemie_api_domain: stale.apiUrl, cookies: stale.cookies })
    );
  });
});
