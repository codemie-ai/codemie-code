import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetStoredCredentials = vi.fn();
const mockSetBaseUrl = vi.fn();
const mockListModels = vi.fn();

vi.mock('../sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = (...args: unknown[]) => mockGetStoredCredentials(...args);
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
    mockGetStoredCredentials.mockReset();
    mockSetBaseUrl.mockReset();
    mockListModels.mockReset();
    mockListModels.mockResolvedValue([{ id: 'gpt-x', name: 'GPT X' }]);
  });

  it('is healthy for a baseUrl-only SSO profile and looks models up via that URL', async () => {
    mockGetStoredCredentials.mockResolvedValue(creds);

    const result = await new SSOHealthCheck().check({ provider: 'ai-run-sso', baseUrl: P } as never);

    expect(result.status).toBe('healthy');
    expect(result.details[0]).toEqual({ status: 'ok', message: `CodeMie URL: ${P}` });
    expect(mockSetBaseUrl).toHaveBeenCalledWith(P);
  });

  it('uses the fallback URL that holds the credentials for model lookup (split host)', async () => {
    mockGetStoredCredentials.mockResolvedValueOnce(null).mockResolvedValueOnce(creds);

    const result = await new SSOHealthCheck().check({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W } as never);

    expect(result.status).toBe('healthy');
    expect(mockSetBaseUrl).toHaveBeenCalledWith(W);
  });

  it('reports incomplete configuration when no URL is set', async () => {
    const result = await new SSOHealthCheck().check({ provider: 'ai-run-sso' } as never);

    expect(result.status).toBe('unhealthy');
    expect(result.message).toBe('SSO Configuration incomplete');
    expect(mockGetStoredCredentials).not.toHaveBeenCalled();
  });

  it('reports missing credentials when no candidate has any', async () => {
    mockGetStoredCredentials.mockResolvedValue(null);

    const result = await new SSOHealthCheck().check({ provider: 'ai-run-sso', baseUrl: P } as never);

    expect(result.status).toBe('unhealthy');
    expect(result.message).toBe('SSO Authentication required');
  });
});
