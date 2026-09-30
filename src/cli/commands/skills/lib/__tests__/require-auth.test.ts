import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetStoredCredentials = vi.fn();
const mockConfigLoad = vi.fn();

vi.mock('@/utils/config.js', () => ({ ConfigLoader: { load: () => mockConfigLoad() } }));
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = (...args: unknown[]) => mockGetStoredCredentials(...args);
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
    mockGetStoredCredentials.mockResolvedValueOnce(null).mockResolvedValueOnce({ cookies: { s: '1' }, apiUrl: W });

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
