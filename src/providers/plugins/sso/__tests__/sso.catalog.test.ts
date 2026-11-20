import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmModel } from '../sso.http-client.js';

const fetchMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<LlmModel[]>>());

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../sso.http-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sso.http-client.js')>()),
  fetchCodeMieLlmModels: (...args: unknown[]) => fetchMock(...args),
}));

// In-memory credential store: the resolver reads the cookie slot and the jwt- slot per URL, and
// the global slot (no URL) when a URL has none.
const { ssoByUrl, jwtByUrl, mockRetrieveSSOCredentials, mockRetrieveJWTCredentials } = vi.hoisted(() => {
  const ssoByUrl = new Map<string | undefined, unknown>();
  const jwtByUrl = new Map<string | undefined, unknown>();
  return {
    ssoByUrl,
    jwtByUrl,
    mockRetrieveSSOCredentials: vi.fn(async (url?: string): Promise<unknown> => ssoByUrl.get(url) ?? null),
    mockRetrieveJWTCredentials: vi.fn(async (url?: string): Promise<unknown> => jwtByUrl.get(url) ?? null),
  };
});
vi.mock('../../../../utils/security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../utils/security.js')>()),
  CredentialStore: {
    getInstance: () => ({
      retrieveSSOCredentials: mockRetrieveSSOCredentials,
      retrieveJWTCredentials: mockRetrieveJWTCredentials,
      clearSSOCredentials: vi.fn(),
      clearJWTCredentials: vi.fn(),
    }),
  },
}));

import { fetchCodeMieCatalogForEnv, projectFromEnv } from '../sso.catalog.js';
import { ConfigurationError } from '../../../../utils/errors.js';

const creds = { cookies: { s: '1' }, apiUrl: 'https://api.sso.example/code-assistant-api' };
const W = 'https://workspace.example.com';
const ssoEnv = { CODEMIE_URL: W };
const models: LlmModel[] = [{ base_name: 'claude-router-standard', deployment_name: 'claude-router-standard', label: 'r', enabled: true }];

describe('fetchCodeMieCatalogForEnv', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    ssoByUrl.clear();
    jwtByUrl.clear();
    mockRetrieveSSOCredentials.mockClear();
    mockRetrieveJWTCredentials.mockClear();
    fetchMock.mockResolvedValue(models);
  });

  it('fetches with the stored JWT when the SSO login left no cookies', async () => {
    jwtByUrl.set(W, { token: 'jwt-tok', apiUrl: creds.apiUrl });
    await fetchCodeMieCatalogForEnv({ ...ssoEnv, CODEMIE_PROJECT: 'router-demo' }, { logPrefix: '[t]' });
    expect(fetchMock).toHaveBeenCalledWith(creds.apiUrl, 'jwt-tok', 'router-demo');
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
    ssoByUrl.set(W, creds);
    await fetchCodeMieCatalogForEnv({ ...ssoEnv, CODEMIE_PROJECT: 'router-demo' }, { logPrefix: '[t]' });
    expect(fetchMock).toHaveBeenCalledWith(creds.apiUrl, creds.cookies, 'router-demo');
  });

  it('asks for the whole catalog when the launch has no project', async () => {
    ssoByUrl.set(W, creds);
    await fetchCodeMieCatalogForEnv({ ...ssoEnv, CODEMIE_PROJECT: '  ' }, { logPrefix: '[t]' });
    expect(fetchMock).toHaveBeenCalledWith(creds.apiUrl, creds.cookies, undefined);
  });

  it('throws a login hint when a platform is configured but not logged in', async () => {
    await expect(fetchCodeMieCatalogForEnv(ssoEnv, { logPrefix: '[t]' }))
      .rejects.toThrow(ConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns undefined instead of throwing when credentials are optional', async () => {
    await expect(fetchCodeMieCatalogForEnv(ssoEnv, { logPrefix: '[t]', requireCredentials: false }))
      .resolves.toBeUndefined();
  });

  it('returns undefined when the environment has no CodeMie auth at all', async () => {
    await expect(fetchCodeMieCatalogForEnv({}, { logPrefix: '[t]' })).resolves.toBeUndefined();
    expect(mockRetrieveSSOCredentials).not.toHaveBeenCalled();
  });
});

describe('projectFromEnv', () => {
  it('trims and treats blank as no project', () => {
    expect(projectFromEnv({ CODEMIE_PROJECT: ' demo ' })).toBe('demo');
    expect(projectFromEnv({ CODEMIE_PROJECT: '' })).toBeUndefined();
    expect(projectFromEnv({})).toBeUndefined();
  });
});
