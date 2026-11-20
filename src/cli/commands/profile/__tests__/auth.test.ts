import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetStoredCredentials = vi.fn();
const mockClearStoredCredentials = vi.fn();
const mockAuthenticate = vi.fn();
const mockConfigLoad = vi.fn();
const mockRetrieveJWTCredentials = vi.fn();

vi.mock('../../../../providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    authenticate = (...args: unknown[]) => mockAuthenticate(...args);
  },
}));
// The real resolver picks the URL; only the clear is observed.
vi.mock('../../../../providers/plugins/sso/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../providers/plugins/sso/auth/index.js')>()),
  clearSSOAuth: (...args: unknown[]) => mockClearStoredCredentials(...args),
}));
// Per-URL cookie and JWT records come from the mocks; the global slots are empty.
vi.mock('../../../../utils/security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../utils/security.js')>()),
  CredentialStore: {
    getInstance: () => ({
      retrieveSSOCredentials: (url?: string) => (url === undefined ? Promise.resolve(null) : mockGetStoredCredentials(url)),
      retrieveJWTCredentials: (url?: string) => (url === undefined ? Promise.resolve(null) : mockRetrieveJWTCredentials(url)),
      clearSSOCredentials: () => Promise.resolve(),
      clearJWTCredentials: () => Promise.resolve(),
    }),
  },
}));
vi.mock('../../../../utils/config.js', () => ({ ConfigLoader: { load: () => mockConfigLoad() } }));
vi.mock('../../../../providers/core/registry.js', () => ({
  ProviderRegistry: {
    getProvider: (name: string) => (name === 'ai-run-sso' ? { authType: 'sso' } : { authType: 'api-key' }),
  },
}));
vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
}));
vi.mock('ora', () => ({
  default: () => ({ start: () => ({ succeed: vi.fn(), fail: vi.fn() }) }),
}));

import { createLoginCommand, createLogoutCommand, createRefreshCommand } from '../auth.js';

const P = 'https://profile.example.com';
const W = 'https://workspace.example.com';

async function run(command: { parseAsync: (argv: string[], opts: { from: 'user' }) => Promise<unknown> }, args: string[] = []): Promise<void> {
  await command.parseAsync(args, { from: 'user' });
}

describe('profile auth commands', () => {
  beforeEach(() => {
    mockGetStoredCredentials.mockReset();
    mockClearStoredCredentials.mockReset();
    mockAuthenticate.mockReset();
    mockConfigLoad.mockReset();
    mockRetrieveJWTCredentials.mockReset();
    mockRetrieveJWTCredentials.mockResolvedValue(null);
    mockAuthenticate.mockResolvedValue({ success: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('login', () => {
    it('authenticates against the profile baseUrl when no --url and no codeMieUrl', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P });
      await run(createLoginCommand());
      expect(mockAuthenticate).toHaveBeenCalledWith({ codeMieUrl: P, timeout: 120000 });
    });

    it('prefers an explicit --url', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
      await run(createLoginCommand(), ['--url', 'https://explicit.example.com']);
      expect(mockAuthenticate).toHaveBeenCalledWith({ codeMieUrl: 'https://explicit.example.com', timeout: 120000 });
    });
  });

  describe('refresh', () => {
    it('proceeds for a baseUrl-only SSO profile and re-logs in on the same URL', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P });
      mockGetStoredCredentials.mockResolvedValue({ cookies: { session: 'abc' }, apiUrl: P });
      await run(createRefreshCommand());
      expect(mockClearStoredCredentials).toHaveBeenCalledWith(P);
      expect(mockAuthenticate).toHaveBeenCalledWith({ codeMieUrl: P, timeout: 120000 });
    });

    it('refreshes the URL that actually holds the credentials (split host)', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
      mockGetStoredCredentials.mockResolvedValueOnce(null).mockResolvedValueOnce({ cookies: { session: 'abc' }, apiUrl: `${P}/code-assistant-api` });
      await run(createRefreshCommand());
      expect(mockClearStoredCredentials).toHaveBeenCalledWith(W);
      expect(mockAuthenticate).toHaveBeenCalledWith({ codeMieUrl: W, timeout: 120000 });
    });

    it('falls back to the first candidate URL when nothing is stored', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
      mockGetStoredCredentials.mockResolvedValue(null);
      await run(createRefreshCommand());
      expect(mockAuthenticate).toHaveBeenCalledWith({ codeMieUrl: P, timeout: 120000 });
    });

    it('refuses non-SSO providers', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'litellm', baseUrl: 'https://llm.example.com' });
      await run(createRefreshCommand());
      expect(mockAuthenticate).not.toHaveBeenCalled();
      expect(mockClearStoredCredentials).not.toHaveBeenCalled();
    });

    it('refuses an SSO profile with no URL at all', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso' });
      await run(createRefreshCommand());
      expect(mockAuthenticate).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('clears only the URL that holds the credentials', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
      mockGetStoredCredentials.mockResolvedValueOnce({ cookies: { session: 'abc' }, apiUrl: `${P}/code-assistant-api` });
      await run(createLogoutCommand());
      expect(mockClearStoredCredentials.mock.calls.map(c => c[0])).toEqual([P]);
    });

    it('clears the URL that holds only a JWT (cookie-stripping reverse proxy)', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
      mockGetStoredCredentials.mockResolvedValue(null);
      // The JWT was issued for the profile's own API host, so the profile-origin filter keeps it.
      mockRetrieveJWTCredentials.mockImplementation(async (url: string) => (url === W ? { token: 't', apiUrl: `${P}/code-assistant-api` } : null));
      await run(createLogoutCommand());
      expect(mockClearStoredCredentials.mock.calls.map(c => c[0])).toEqual([W]);
    });

    it('clears the baseUrl of a baseUrl-only profile', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P });
      await run(createLogoutCommand());
      expect(mockClearStoredCredentials.mock.calls.map(c => c[0])).toEqual([P]);
    });

    it('clears the default credential slot when no URL is configured', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso' });
      await run(createLogoutCommand());
      expect(mockClearStoredCredentials).toHaveBeenCalledWith(undefined);
    });
  });
});
