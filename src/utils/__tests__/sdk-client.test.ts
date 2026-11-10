import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetStoredCredentials = vi.fn();
const mockConfigLoad = vi.fn();
const mockCodeMieClient = vi.fn();
const mockRetrieveSSOCredentials = vi.fn();
const mockClearSSOCredentials = vi.fn();
let useRealSso = false;

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
    }),
  },
}));
vi.mock('../../providers/plugins/sso/sso.auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../providers/plugins/sso/sso.auth.js')>();
  return {
    CodeMieSSO: class {
      getStoredCredentials = (...args: unknown[]) =>
        useRealSso
          ? new actual.CodeMieSSO().getStoredCredentials(...(args as [string?, boolean?]))
          : mockGetStoredCredentials(...args);
    },
  };
});

import { getCodemieClient } from '../sdk-client.js';

const P = 'https://profile.example.com';
const W = 'https://workspace.example.com';
const creds = { cookies: { session: 'abc' }, apiUrl: `${P}/code-assistant-api` };

describe('getCodemieClient credential lookup', () => {
  beforeEach(() => {
    mockGetStoredCredentials.mockReset();
    mockConfigLoad.mockReset();
    mockCodeMieClient.mockReset();
    mockRetrieveSSOCredentials.mockReset();
    mockClearSSOCredentials.mockReset();
    useRealSso = false;
  });

  it('finds credentials via the profile baseUrl for a baseUrl-only SSO profile', async () => {
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P });
    mockGetStoredCredentials.mockResolvedValue(creds);

    await getCodemieClient(true);

    expect(mockGetStoredCredentials).toHaveBeenCalledWith(P);
    expect(mockCodeMieClient).toHaveBeenCalledWith(expect.objectContaining({ codemie_api_domain: creds.apiUrl }));
  });

  it('falls back to codeMieUrl when the baseUrl lookup misses', async () => {
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
    mockGetStoredCredentials.mockResolvedValueOnce(null).mockResolvedValueOnce(creds);

    await getCodemieClient(true);

    expect(mockGetStoredCredentials.mock.calls.map(c => c[0])).toEqual([P, W]);
    expect(mockCodeMieClient).toHaveBeenCalled();
  });

  it('throws when no credentials are found under any candidate', async () => {
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
    mockGetStoredCredentials.mockResolvedValue(null);

    await expect(getCodemieClient(true)).rejects.toThrow('SSO authentication required');
  });

  it('creates the client for a stale cookie-only credential without clearing it', async () => {
    useRealSso = true;
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
});
