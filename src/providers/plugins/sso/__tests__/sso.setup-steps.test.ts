import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory credential store: the resolver reads the cookie slot and the jwt- slot per URL, and
// the global slot (no URL) when a URL has none.
const { ssoByUrl, mockRetrieveSSOCredentials } = vi.hoisted(() => {
  const ssoByUrl = new Map<string | undefined, unknown>();
  return {
    ssoByUrl,
    mockRetrieveSSOCredentials: vi.fn(async (url?: string): Promise<unknown> => ssoByUrl.get(url) ?? null),
  };
});
vi.mock('../../../../utils/security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../utils/security.js')>()),
  CredentialStore: {
    getInstance: () => ({
      retrieveSSOCredentials: mockRetrieveSSOCredentials,
      retrieveJWTCredentials: vi.fn(async () => null),
      clearSSOCredentials: vi.fn(),
      clearJWTCredentials: vi.fn(),
    }),
  },
}));

const mockAuthenticate = vi.fn();
const mockFetchModels = vi.fn();
const mockPrompt = vi.fn();

vi.mock('../sso.auth.js', () => ({
  CodeMieSSO: class {
    authenticate = (...args: unknown[]) => mockAuthenticate(...args);
  },
}));
vi.mock('../sso.http-client.js', () => ({
  fetchCodeMieModels: (...args: unknown[]) => mockFetchModels(...args),
  fetchCodeMieIntegrations: vi.fn(),
}));
vi.mock('../sso.models.js', () => ({ SSOModelProxy: class {} }));
vi.mock('inquirer', () => ({ default: { prompt: (...args: unknown[]) => mockPrompt(...args) } }));
vi.mock('ora', () => ({ default: () => ({ start: () => ({ succeed: vi.fn(), fail: vi.fn() }) }) }));
vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
}));

import { SSOSetupSteps } from '../sso.setup-steps.js';

const P = 'https://profile.example.com';
const W = 'https://workspace.example.com';
// An access-token cookie makes expiresAt count; the resolver drops a record that has already expired.
const EXPIRES_AT = Date.now() + 3_600_000;
const creds = { cookies: { codemie_access_token: 'jwt' }, apiUrl: `${P}/code-assistant-api`, expiresAt: EXPIRES_AT };

/** URLs the cookie slot was read for, global-slot reads left out. */
const ssoReadUrls = (): unknown[] => mockRetrieveSSOCredentials.mock.calls.map((c) => c[0]).filter((u) => u !== undefined);

describe('SSOSetupSteps platform URL resolution', () => {
  beforeEach(() => {
    ssoByUrl.clear();
    mockRetrieveSSOCredentials.mockClear();
    mockAuthenticate.mockReset();
    mockFetchModels.mockReset();
    mockPrompt.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('getAuthStatus', () => {
    it('reports authenticated for a baseUrl-only SSO profile', async () => {
      ssoByUrl.set(P, creds);
      const status = await SSOSetupSteps.getAuthStatus!({ provider: 'ai-run-sso', baseUrl: P } as never);
      expect(status).toEqual({ authenticated: true, expiresAt: EXPIRES_AT, apiUrl: creds.apiUrl });
      expect(mockRetrieveSSOCredentials).toHaveBeenCalledWith(P);
    });

    it('falls back to codeMieUrl when the baseUrl lookup misses', async () => {
      ssoByUrl.set(W, creds);
      const status = await SSOSetupSteps.getAuthStatus!({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W } as never);
      expect(status.authenticated).toBe(true);
      expect(ssoReadUrls()).toEqual([P, W]);
    });

    it('never probes a vendor baseUrl for anthropic-subscription', async () => {
      const status = await SSOSetupSteps.getAuthStatus!({
        provider: 'anthropic-subscription',
        baseUrl: 'https://api.anthropic.com',
      } as never);
      expect(status).toEqual({ authenticated: false });
      expect(ssoReadUrls()).toEqual([]);
    });
  });

  describe('cookie-only credentials', () => {
    const cookieOnly = { cookies: { s: '1' }, apiUrl: `${P}/code-assistant-api`, expiresAt: 123 };

    it('getAuthStatus reports no expiresAt', async () => {
      ssoByUrl.set(P, cookieOnly);
      const status = await SSOSetupSteps.getAuthStatus!({ provider: 'ai-run-sso', baseUrl: P } as never);
      expect(status.authenticated).toBe(true);
      expect(status.expiresAt).toBeUndefined();
    });

    it('validateAuth reports no expiresAt', async () => {
      ssoByUrl.set(P, cookieOnly);
      mockFetchModels.mockResolvedValue([]);
      const result = await SSOSetupSteps.validateAuth!({ provider: 'ai-run-sso', baseUrl: P } as never);
      expect(result.valid).toBe(true);
      expect(result.expiresAt).toBeUndefined();
    });
  });

  describe('validateAuth', () => {
    it('is valid for a baseUrl-only SSO profile', async () => {
      ssoByUrl.set(P, creds);
      mockFetchModels.mockResolvedValue([]);
      const result = await SSOSetupSteps.validateAuth!({ provider: 'ai-run-sso', baseUrl: P } as never);
      expect(result).toEqual({ valid: true, expiresAt: EXPIRES_AT });
    });

    it('reports the resolved URL in the login hint when credentials are missing', async () => {
      const result = await SSOSetupSteps.validateAuth!({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W } as never);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(`codemie profile login --url ${P}`);
    });

    it('errors when no URL is configured', async () => {
      const result = await SSOSetupSteps.validateAuth!({ provider: 'ai-run-sso' } as never);
      expect(result).toEqual({ valid: false, error: 'No CodeMie URL configured' });
    });
  });

  describe('promptForReauth', () => {
    it('re-authenticates against the profile baseUrl when codeMieUrl is missing', async () => {
      mockPrompt.mockResolvedValue({ confirm: true });
      mockAuthenticate.mockResolvedValue({ success: true });
      const ok = await SSOSetupSteps.promptForReauth!({ provider: 'ai-run-sso', baseUrl: P } as never);
      expect(ok).toBe(true);
      expect(mockAuthenticate).toHaveBeenCalledWith({ codeMieUrl: P, timeout: 120000 });
    });

    it('bails when there is no URL at all', async () => {
      mockPrompt.mockResolvedValue({ confirm: true });
      const ok = await SSOSetupSteps.promptForReauth!({ provider: 'ai-run-sso' } as never);
      expect(ok).toBe(false);
      expect(mockAuthenticate).not.toHaveBeenCalled();
    });
  });
});
