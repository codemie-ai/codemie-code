import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetStoredCredentials = vi.fn();
const mockFetchLlmModels = vi.fn();

vi.mock('../sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = (...args: unknown[]) => mockGetStoredCredentials(...args);
  },
}));
vi.mock('../sso.http-client.js', () => ({
  fetchCodeMieLlmModels: (...args: unknown[]) => mockFetchLlmModels(...args),
  fetchCodeMieIntegrations: vi.fn(),
  CODEMIE_ENDPOINTS: { USER_SETTINGS: '/v1/settings/user' },
}));
vi.mock('../../../../utils/logger.js', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { SSOModelProxy } from '../sso.models.js';

const P = 'https://profile.example.com';
const W = 'https://workspace.example.com';

describe('SSOModelProxy.fetchModels', () => {
  beforeEach(() => {
    mockGetStoredCredentials.mockReset();
    mockFetchLlmModels.mockReset();
    mockFetchLlmModels.mockResolvedValue([{ deployment_name: 'gpt-x', label: 'GPT X' }]);
  });

  it('finds credentials via baseUrl for a baseUrl-only SSO profile and uses the credentials apiUrl', async () => {
    mockGetStoredCredentials.mockResolvedValue({ cookies: { s: '1' }, apiUrl: `${P}/code-assistant-api` });

    const models = await new SSOModelProxy().fetchModels({ provider: 'ai-run-sso', baseUrl: P } as never);

    expect(mockGetStoredCredentials).toHaveBeenCalledWith(P);
    expect(mockFetchLlmModels).toHaveBeenCalledWith(`${P}/code-assistant-api`, { s: '1' });
    expect(models.map(m => m.id)).toEqual(['gpt-x']);
  });

  it('falls back to codeMieUrl when baseUrl misses', async () => {
    mockGetStoredCredentials.mockResolvedValueOnce(null).mockResolvedValueOnce({ cookies: { s: '1' }, apiUrl: '' });

    const models = await new SSOModelProxy().fetchModels({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W } as never);

    expect(mockGetStoredCredentials.mock.calls.map(c => c[0])).toEqual([P, W]);
    // credentials.apiUrl is empty, so the resolved lookup URL is used
    expect(mockFetchLlmModels).toHaveBeenCalledWith(W, { s: '1' });
    expect(models).toHaveLength(1);
  });

  it('returns an empty list when no credentials are stored', async () => {
    mockGetStoredCredentials.mockResolvedValue(null);

    const models = await new SSOModelProxy().fetchModels({ provider: 'ai-run-sso', baseUrl: P } as never);

    expect(models).toEqual([]);
  });
});
