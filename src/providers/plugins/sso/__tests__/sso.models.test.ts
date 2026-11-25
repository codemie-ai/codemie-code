/**
 * Regression tests for EPMCDME-15259.
 *
 * SSOModelProxy.fetchModels() used to swallow every failure (missing creds,
 * network error, HTTP error, ...) into an empty array, so the setup wizard
 * always printed "Found 0 available models" with zero indication anything
 * failed. Fixed by:
 *   - using the cookies the setup wizard already has from the just-completed
 *     browser auth (see sso.setup-steps.ts getCredentials()) instead of
 *     re-resolving credentials from disk/keychain, and
 *   - letting real API/network errors propagate instead of catching them
 *     into `[]`.
 *
 * The stored-credential resolver is still exercised for the fallback path (no
 * login supplied, e.g. `codemie models list`), where a genuine "no credentials
 * yet" result must still resolve to `[]`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodeMieConfigOptions } from '../../../../env/types.js';

const fetchCodeMieLlmModelsMock = vi.hoisted(() => vi.fn());

vi.mock('../sso.http-client.js', () => ({
  fetchCodeMieLlmModels: fetchCodeMieLlmModelsMock,
  fetchCodeMieIntegrations: vi.fn(),
  CODEMIE_ENDPOINTS: { USER_SETTINGS: '/v1/settings/user' },
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

import { SSOModelProxy } from '../sso.models.js';
import { toSSOAuth } from '../auth/selection.js';

/** URLs the cookie slot was read for, global-slot reads left out. */
const ssoReadUrls = (): unknown[] => mockRetrieveSSOCredentials.mock.calls.map((c) => c[0]).filter((u) => u !== undefined);

function cfg(fields: Partial<CodeMieConfigOptions> = {}): CodeMieConfigOptions {
  return {
    provider: 'ai-run-sso',
    baseUrl: 'https://codemie.example.com',
    apiKey: 'sso-provided',
    model: 'temp',
    ...fields,
  } as CodeMieConfigOptions;
}

describe('SSOModelProxy.fetchModels', () => {
  beforeEach(() => {
    fetchCodeMieLlmModelsMock.mockReset();
    ssoByUrl.clear();
    jwtByUrl.clear();
    mockRetrieveSSOCredentials.mockClear();
    mockRetrieveJWTCredentials.mockClear();
  });

  it('uses a JWT login supplied by the setup wizard', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([{ deployment_name: 'gpt-4o', label: 'GPT-4o' }]);
    const apiUrl = 'https://codemie.example.com/code-assistant-api';
    const config = {
      ...cfg({ baseUrl: apiUrl }),
      auth: toSSOAuth({ type: 'jwt', record: { token: 'wizard-jwt', apiUrl } }, apiUrl),
    } as CodeMieConfigOptions;

    await new SSOModelProxy().fetchModels(config);

    expect(mockRetrieveSSOCredentials).not.toHaveBeenCalled();
    expect(mockRetrieveJWTCredentials).not.toHaveBeenCalled();
    expect(fetchCodeMieLlmModelsMock).toHaveBeenCalledWith('https://codemie.example.com/code-assistant-api', 'wizard-jwt', undefined);
  });

  it('falls back to a stored JWT when no SSO session is stored', async () => {
    jwtByUrl.set('https://codemie.example.com', { token: 'stored-jwt', apiUrl: 'https://codemie.example.com/code-assistant-api' });
    fetchCodeMieLlmModelsMock.mockResolvedValue([{ deployment_name: 'gpt-4o', label: 'GPT-4o' }]);

    const models = await new SSOModelProxy().fetchModels(cfg({ codeMieUrl: 'https://codemie.example.com' }));

    expect(models).toHaveLength(1);
    expect(fetchCodeMieLlmModelsMock).toHaveBeenCalledWith('https://codemie.example.com/code-assistant-api', 'stored-jwt', undefined);
  });

  it('uses cookies supplied by the setup wizard directly, without resolving stored credentials', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      { deployment_name: 'gpt-4o', label: 'GPT-4o' },
    ]);

    const proxy = new SSOModelProxy();
    // Org URL (frontend) and API URL differ in real setup; the API URL must win.
    const config = {
      ...cfg({
        codeMieUrl: 'https://codemie.example.com',
        baseUrl: 'https://codemie.example.com/code-assistant-api',
      }),
      auth: toSSOAuth(
        { type: 'cookie', record: { cookies: { codemie_access_token: 'fresh-cookie' }, apiUrl: 'https://codemie.example.com/code-assistant-api' } },
        'https://codemie.example.com'
      ),
    } as CodeMieConfigOptions;

    const models = await proxy.fetchModels(config);

    expect(models).toEqual([
      expect.objectContaining({ id: 'gpt-4o', name: 'GPT-4o' }),
    ]);
    expect(mockRetrieveSSOCredentials).not.toHaveBeenCalled();
    expect(fetchCodeMieLlmModelsMock).toHaveBeenCalledWith(
      'https://codemie.example.com/code-assistant-api',
      { codemie_access_token: 'fresh-cookie' },
      undefined
    );
  });

  it('propagates a real API failure instead of swallowing it into an empty array', async () => {
    fetchCodeMieLlmModelsMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const proxy = new SSOModelProxy();
    const config = {
      ...cfg({ codeMieUrl: 'https://codemie.example.com' }),
      auth: toSSOAuth(
        { type: 'cookie', record: { cookies: { codemie_access_token: 'fresh-cookie' }, apiUrl: 'https://codemie.example.com' } },
        'https://codemie.example.com'
      ),
    } as CodeMieConfigOptions;

    await expect(proxy.fetchModels(config)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('falls back to stored credentials when no login is supplied', async () => {
    ssoByUrl.set('https://codemie.example.com', {
      apiUrl: 'https://codemie.example.com',
      cookies: { codemie_access_token: 'stored-cookie' },
    });
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      { deployment_name: 'gpt-4o', label: 'GPT-4o' },
    ]);

    const proxy = new SSOModelProxy();
    const models = await proxy.fetchModels(cfg({ codeMieUrl: 'https://codemie.example.com' }));

    expect(models).toHaveLength(1);
    expect(mockRetrieveSSOCredentials).toHaveBeenCalled();
  });

  it('returns an empty array only for the genuine no-credentials-yet case', async () => {

    const proxy = new SSOModelProxy();
    const models = await proxy.fetchModels(cfg({ codeMieUrl: 'https://codemie.example.com' }));

    expect(models).toEqual([]);
    expect(fetchCodeMieLlmModelsMock).not.toHaveBeenCalled();
  });

  it('propagates a real API failure from the stored-credentials fallback path too', async () => {
    ssoByUrl.set('https://codemie.example.com', {
      apiUrl: 'https://codemie.example.com',
      cookies: { codemie_access_token: 'stored-cookie' },
    });
    fetchCodeMieLlmModelsMock.mockRejectedValue(new Error('HTTP 500'));

    const proxy = new SSOModelProxy();

    await expect(
      proxy.fetchModels(cfg({ codeMieUrl: 'https://codemie.example.com' }))
    ).rejects.toThrow(/HTTP 500/);
  });

  describe('profile URL precedence', () => {
    const P = 'https://profile.example.com';
    const W = 'https://workspace.example.com';

    it('finds credentials via baseUrl for a baseUrl-only SSO profile and uses the credentials apiUrl', async () => {
      ssoByUrl.set(P, { cookies: { s: '1' }, apiUrl: `${P}/code-assistant-api` });
      fetchCodeMieLlmModelsMock.mockResolvedValue([{ deployment_name: 'gpt-x', label: 'GPT X' }]);

      const models = await new SSOModelProxy().fetchModels({ provider: 'ai-run-sso', baseUrl: P } as CodeMieConfigOptions);

      expect(mockRetrieveSSOCredentials).toHaveBeenCalledWith(P);
      expect(fetchCodeMieLlmModelsMock).toHaveBeenCalledWith(`${P}/code-assistant-api`, { s: '1' }, undefined);
      expect(models.map(m => m.id)).toEqual(['gpt-x']);
    });

    it('falls back to codeMieUrl when baseUrl misses', async () => {
      ssoByUrl.set(W, { cookies: { s: '1' }, apiUrl: `${P}/code-assistant-api` });
      fetchCodeMieLlmModelsMock.mockResolvedValue([{ deployment_name: 'gpt-x', label: 'GPT X' }]);

      const models = await new SSOModelProxy().fetchModels({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W } as CodeMieConfigOptions);

      expect(ssoReadUrls()).toEqual([P, W]);
      // split host: the login stored under W was issued for the profile's API host
      expect(fetchCodeMieLlmModelsMock).toHaveBeenCalledWith(`${P}/code-assistant-api`, { s: '1' }, undefined);
      expect(models).toHaveLength(1);
    });
  });
});
