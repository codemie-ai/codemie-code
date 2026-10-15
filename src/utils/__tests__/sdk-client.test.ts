import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetStoredCredentials = vi.fn();
const mockConfigLoad = vi.fn();
const mockCodeMieClient = vi.fn();

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
vi.mock('../../providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = (...args: unknown[]) => mockGetStoredCredentials(...args);
  },
}));

import { getCodemieClient } from '../sdk-client.js';

const P = 'https://profile.example.com';
const W = 'https://workspace.example.com';
const creds = { cookies: { session: 'abc' }, apiUrl: `${P}/code-assistant-api` };

describe('getCodemieClient credential lookup', () => {
  beforeEach(() => {
    mockGetStoredCredentials.mockReset();
    mockConfigLoad.mockReset();
    mockCodeMieClient.mockReset();
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
});
