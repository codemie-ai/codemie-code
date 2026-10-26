import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetStoredCredentials = vi.fn();
const mockAuthenticate = vi.fn();
const mockFetchModels = vi.fn();
const mockPrompt = vi.fn();

vi.mock('../sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = (...args: unknown[]) => mockGetStoredCredentials(...args);
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
const creds = { cookies: { s: '1' }, apiUrl: `${P}/code-assistant-api`, expiresAt: 123 };

describe('SSOSetupSteps platform URL resolution', () => {
  beforeEach(() => {
    mockGetStoredCredentials.mockReset();
    mockAuthenticate.mockReset();
    mockFetchModels.mockReset();
    mockPrompt.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('getAuthStatus', () => {
    it('reports authenticated for a baseUrl-only SSO profile', async () => {
      mockGetStoredCredentials.mockResolvedValue(creds);
      const status = await SSOSetupSteps.getAuthStatus!({ provider: 'ai-run-sso', baseUrl: P } as never);
      expect(status).toEqual({ authenticated: true, expiresAt: 123, apiUrl: creds.apiUrl });
      expect(mockGetStoredCredentials).toHaveBeenCalledWith(P);
    });

    it('falls back to codeMieUrl when the baseUrl lookup misses', async () => {
      mockGetStoredCredentials.mockResolvedValueOnce(null).mockResolvedValueOnce(creds);
      const status = await SSOSetupSteps.getAuthStatus!({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W } as never);
      expect(status.authenticated).toBe(true);
      expect(mockGetStoredCredentials.mock.calls.map(c => c[0])).toEqual([P, W]);
    });

    it('never probes a vendor baseUrl for anthropic-subscription', async () => {
      mockGetStoredCredentials.mockResolvedValue(null);
      const status = await SSOSetupSteps.getAuthStatus!({
        provider: 'anthropic-subscription',
        baseUrl: 'https://api.anthropic.com',
      } as never);
      expect(status).toEqual({ authenticated: false });
      expect(mockGetStoredCredentials).not.toHaveBeenCalled();
    });
  });

  describe('validateAuth', () => {
    it('is valid for a baseUrl-only SSO profile', async () => {
      mockGetStoredCredentials.mockResolvedValue(creds);
      mockFetchModels.mockResolvedValue([]);
      const result = await SSOSetupSteps.validateAuth!({ provider: 'ai-run-sso', baseUrl: P } as never);
      expect(result).toEqual({ valid: true, expiresAt: 123 });
    });

    it('reports the resolved URL in the login hint when credentials are missing', async () => {
      mockGetStoredCredentials.mockResolvedValue(null);
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
