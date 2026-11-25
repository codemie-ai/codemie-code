import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetStoredCredentials = vi.fn();
const mockClearStoredCredentials = vi.fn();
const mockAuthenticate = vi.fn();
const mockConfigLoad = vi.fn();

vi.mock('../../../../providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = (...args: unknown[]) => mockGetStoredCredentials(...args);
    clearStoredCredentials = (...args: unknown[]) => mockClearStoredCredentials(...args);
    authenticate = (...args: unknown[]) => mockAuthenticate(...args);
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
const mockOra = vi.hoisted(() => vi.fn());
vi.mock('ora', () => ({ default: mockOra }));

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
    mockAuthenticate.mockResolvedValue({ success: true });
    mockOra.mockReset();
    mockOra.mockReturnValue({ start: () => ({ succeed: vi.fn(), fail: vi.fn() }) });
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

  describe('headless login', () => {
    it.each([['--no-browser'], ['--headless']])('%s authenticates headless without a spinner', async (flag) => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P });
      await run(createLoginCommand(), [flag]);
      expect(mockAuthenticate).toHaveBeenCalledWith({ codeMieUrl: P, timeout: 120000, headless: true });
      expect(mockOra).not.toHaveBeenCalled();
    });

    it('refresh --no-browser keeps existing credentials when authenticate fails', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P });
      mockGetStoredCredentials.mockResolvedValue({ cookies: {}, apiUrl: P });
      mockAuthenticate.mockResolvedValue({ success: false, error: 'bad paste' });
      await run(createRefreshCommand(), ['--no-browser']);
      expect(mockAuthenticate).toHaveBeenCalledWith({ codeMieUrl: P, timeout: 120000, headless: true });
      expect(mockClearStoredCredentials).not.toHaveBeenCalled();
    });

    it('refresh --no-browser never clears credentials before a successful store', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P });
      mockGetStoredCredentials.mockResolvedValue({ cookies: {}, apiUrl: P });
      mockAuthenticate.mockRejectedValue(new Error('boom'));
      await run(createRefreshCommand(), ['--headless']);
      expect(mockClearStoredCredentials).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('proceeds for a baseUrl-only SSO profile and re-logs in on the same URL', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P });
      mockGetStoredCredentials.mockResolvedValue({ cookies: {}, apiUrl: P });
      await run(createRefreshCommand());
      expect(mockClearStoredCredentials).toHaveBeenCalledWith(P);
      expect(mockAuthenticate).toHaveBeenCalledWith({ codeMieUrl: P, timeout: 120000 });
    });

    it('refreshes the URL that actually holds the credentials (split host)', async () => {
      mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
      mockGetStoredCredentials.mockResolvedValueOnce(null).mockResolvedValueOnce({ cookies: {}, apiUrl: `${P}/code-assistant-api` });
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
      mockGetStoredCredentials.mockResolvedValueOnce({ cookies: {}, apiUrl: `${P}/code-assistant-api` });
      await run(createLogoutCommand());
      expect(mockClearStoredCredentials.mock.calls.map(c => c[0])).toEqual([P]);
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
