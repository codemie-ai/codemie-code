import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmModel } from '../sso.http-client.js';

const fetchMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<LlmModel[]>>());
const ssoMock = vi.hoisted(() => ({ getStoredCredentials: vi.fn() }));

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../sso.http-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sso.http-client.js')>()),
  fetchCodeMieLlmModels: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('../sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = (...args: unknown[]) => ssoMock.getStoredCredentials(...args);
  },
}));

import { fetchCodeMieCatalogForEnv, projectFromEnv } from '../sso.catalog.js';
import { ConfigurationError } from '../../../../utils/errors.js';

const creds = { cookies: { s: '1' }, apiUrl: 'https://api.sso.example/code-assistant-api' };
const ssoEnv = { CODEMIE_URL: 'https://workspace.example.com' };
const models: LlmModel[] = [{ base_name: 'claude-router-standard', deployment_name: 'claude-router-standard', label: 'r', enabled: true }];

describe('fetchCodeMieCatalogForEnv', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    ssoMock.getStoredCredentials.mockReset();
    fetchMock.mockResolvedValue(models);
  });

  it('sends the JWT launch project', async () => {
    const result = await fetchCodeMieCatalogForEnv(
      { CODEMIE_JWT_TOKEN: 'tok', CODEMIE_BASE_URL: 'https://api.example.com', CODEMIE_PROJECT: 'router-demo' },
      { logPrefix: '[t]' }
    );
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com', 'tok', 'router-demo');
    expect(result).toBe(models);
  });

  it('prefers an explicit JWT base URL over CODEMIE_BASE_URL', async () => {
    await fetchCodeMieCatalogForEnv(
      { CODEMIE_JWT_TOKEN: 'tok', CODEMIE_BASE_URL: 'http://localhost:4001' },
      { logPrefix: '[t]', jwtBaseUrl: 'https://real.example.com/api' }
    );
    expect(fetchMock).toHaveBeenCalledWith('https://real.example.com/api', 'tok', undefined);
  });

  it('sends the SSO launch project with the stored credentials', async () => {
    ssoMock.getStoredCredentials.mockResolvedValue(creds);
    await fetchCodeMieCatalogForEnv({ ...ssoEnv, CODEMIE_PROJECT: 'router-demo' }, { logPrefix: '[t]' });
    expect(fetchMock).toHaveBeenCalledWith(creds.apiUrl, creds.cookies, 'router-demo');
  });

  it('asks for the whole catalog when the launch has no project', async () => {
    ssoMock.getStoredCredentials.mockResolvedValue(creds);
    await fetchCodeMieCatalogForEnv({ ...ssoEnv, CODEMIE_PROJECT: '  ' }, { logPrefix: '[t]' });
    expect(fetchMock).toHaveBeenCalledWith(creds.apiUrl, creds.cookies, undefined);
  });

  it('throws a login hint when a platform is configured but not logged in', async () => {
    ssoMock.getStoredCredentials.mockResolvedValue(null);
    await expect(fetchCodeMieCatalogForEnv(ssoEnv, { logPrefix: '[t]' }))
      .rejects.toThrow(ConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns undefined instead of throwing when credentials are optional', async () => {
    ssoMock.getStoredCredentials.mockResolvedValue(null);
    await expect(fetchCodeMieCatalogForEnv(ssoEnv, { logPrefix: '[t]', requireCredentials: false }))
      .resolves.toBeUndefined();
  });

  it('returns undefined when the environment has no CodeMie auth at all', async () => {
    await expect(fetchCodeMieCatalogForEnv({}, { logPrefix: '[t]' })).resolves.toBeUndefined();
    expect(ssoMock.getStoredCredentials).not.toHaveBeenCalled();
  });
});

describe('projectFromEnv', () => {
  it('trims and treats blank as no project', () => {
    expect(projectFromEnv({ CODEMIE_PROJECT: ' demo ' })).toBe('demo');
    expect(projectFromEnv({ CODEMIE_PROJECT: '' })).toBeUndefined();
    expect(projectFromEnv({})).toBeUndefined();
  });
});
