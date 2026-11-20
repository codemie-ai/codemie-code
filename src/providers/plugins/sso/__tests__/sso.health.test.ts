import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSetBaseUrl = vi.fn();
const mockListModels = vi.fn();

// In-memory credential store: the resolver reads the cookie slot and the jwt- slot per URL, and
// the global slot (no URL) when a URL has none.
const { ssoByUrl, mockRetrieveSSOCredentials, mockClearSSOCredentials } = vi.hoisted(() => {
  const ssoByUrl = new Map<string | undefined, unknown>();
  return {
    ssoByUrl,
    mockRetrieveSSOCredentials: vi.fn(async (url?: string): Promise<unknown> => ssoByUrl.get(url) ?? null),
    mockClearSSOCredentials: vi.fn(async (url?: string): Promise<void> => {
      ssoByUrl.delete(url);
    }),
  };
});
vi.mock('../../../../utils/security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../utils/security.js')>()),
  CredentialStore: {
    getInstance: () => ({
      retrieveSSOCredentials: mockRetrieveSSOCredentials,
      retrieveJWTCredentials: vi.fn(async () => null),
      clearSSOCredentials: mockClearSSOCredentials,
      clearJWTCredentials: vi.fn(),
    }),
  },
}));
vi.mock('../sso.models.js', () => ({
  SSOModelProxy: class {
    setBaseUrl = (...args: unknown[]) => mockSetBaseUrl(...args);
    listModels = () => mockListModels();
  },
}));
vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { SSOHealthCheck } from '../sso.health.js';

const P = 'https://profile.example.com';
const W = 'https://workspace.example.com';
const creds = { cookies: { s: '1' }, apiUrl: `${P}/code-assistant-api` };

describe('SSOHealthCheck platform URL resolution', () => {
  beforeEach(() => {
    ssoByUrl.clear();
    mockRetrieveSSOCredentials.mockClear();
    mockClearSSOCredentials.mockClear();
    mockSetBaseUrl.mockReset();
    mockListModels.mockReset();
    mockListModels.mockResolvedValue([{ id: 'gpt-x', name: 'GPT X' }]);
  });

  it('is healthy for a baseUrl-only SSO profile and looks models up via that URL', async () => {
    ssoByUrl.set(P, creds);

    const result = await new SSOHealthCheck().check({ provider: 'ai-run-sso', baseUrl: P } as never);

    expect(result.status).toBe('healthy');
    expect(result.details[0]).toEqual({ status: 'ok', message: `CodeMie URL: ${P}` });
    expect(mockSetBaseUrl).toHaveBeenCalledWith(P);
  });

  it('uses the fallback URL that holds the credentials for model lookup (split host)', async () => {
    ssoByUrl.set(W, creds);

    const result = await new SSOHealthCheck().check({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W } as never);

    expect(result.status).toBe('healthy');
    expect(mockSetBaseUrl).toHaveBeenCalledWith(W);
  });

  it('reports incomplete configuration when no URL is set', async () => {
    const result = await new SSOHealthCheck().check({ provider: 'ai-run-sso' } as never);

    expect(result.status).toBe('unhealthy');
    expect(result.message).toBe('SSO Configuration incomplete');
    expect(mockRetrieveSSOCredentials).not.toHaveBeenCalled();
  });

  it('reports missing credentials when no candidate has any', async () => {
    const result = await new SSOHealthCheck().check({ provider: 'ai-run-sso', baseUrl: P } as never);

    expect(result.status).toBe('unhealthy');
    expect(result.message).toBe('SSO Authentication required');
  });

  it('does not report expiry for cookie-only credentials with a past expiresAt', async () => {
    ssoByUrl.set(P, { ...creds, expiresAt: Date.now() - 3600_000 });

    const result = await new SSOHealthCheck().check({ provider: 'ai-run-sso', baseUrl: P } as never);

    expect(result.status).toBe('healthy');
    expect(result.details.some(d => d.message === 'SSO session expired')).toBe(false);
    expect(result.details.some(d => /Session expires in/.test(d.message))).toBe(false);
  });

  // The resolver drops (and clears) an expired record before the health check sees it, as the
  // old getStoredCredentials did, so an expired JWT-bearing login reads as "not logged in".
  it('still treats JWT-bearing credentials with a past expiresAt as expired', async () => {
    ssoByUrl.set(P, {
      ...creds,
      cookies: { codemie_access_token: 'jwt' },
      expiresAt: Date.now() - 3600_000,
    });

    const result = await new SSOHealthCheck().check({ provider: 'ai-run-sso', baseUrl: P } as never);

    expect(result.status).toBe('unhealthy');
    expect(result.message).toBe('SSO Authentication required');
    expect(mockClearSSOCredentials).toHaveBeenCalledWith(P);
  });
});
