import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetStoredCredentials = vi.fn();
const mockConfigLoad = vi.fn();

vi.mock('@/utils/config.js', () => ({ ConfigLoader: { load: () => mockConfigLoad() } }));
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
// The resolver reads per-URL cookie records through the credential store; the global slot and
// the JWT slot are empty here.
vi.mock('@/utils/security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/security.js')>()),
  CredentialStore: {
    getInstance: () => ({
      retrieveSSOCredentials: (url?: string) => (url === undefined ? Promise.resolve(null) : mockGetStoredCredentials(url)),
      retrieveJWTCredentials: () => Promise.resolve(null),
      clearSSOCredentials: () => Promise.resolve(),
      clearJWTCredentials: () => Promise.resolve(),
    }),
  },
}));

import { requireAuthenticatedSession } from '../require-auth.js';

const P = 'https://profile.example.com';
const W = 'https://workspace.example.com';

describe('requireAuthenticatedSession', () => {
  beforeEach(() => {
    mockGetStoredCredentials.mockReset();
    mockConfigLoad.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });

  it('authenticates a baseUrl-only SSO profile via the profile URL', async () => {
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P });
    mockGetStoredCredentials.mockResolvedValue({ cookies: { s: '1' }, apiUrl: P });

    await expect(requireAuthenticatedSession()).resolves.toBe(true);
    expect(mockGetStoredCredentials).toHaveBeenCalledWith(P);
  });

  it('falls back to codeMieUrl when the baseUrl lookup misses', async () => {
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
    mockGetStoredCredentials.mockResolvedValueOnce(null).mockResolvedValueOnce({ cookies: { s: '1' }, apiUrl: `${P}/code-assistant-api` });

    await expect(requireAuthenticatedSession()).resolves.toBe(true);
    expect(mockGetStoredCredentials.mock.calls.map(c => c[0])).toEqual([P, W]);
  });

  it('exits when no URL is configured', async () => {
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso' });

    await expect(requireAuthenticatedSession()).rejects.toThrow('exit:1');
    expect(mockGetStoredCredentials).not.toHaveBeenCalled();
  });

  it('exits when no credentials exist under any candidate', async () => {
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
    mockGetStoredCredentials.mockResolvedValue(null);

    await expect(requireAuthenticatedSession()).rejects.toThrow('exit:1');
  });
});
