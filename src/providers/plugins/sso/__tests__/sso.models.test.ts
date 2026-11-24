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
 * `getStoredCredentials` is still exercised for the fallback path (no cookies
 * supplied, e.g. `codemie models list`), where a genuine "no credentials yet"
 * result must still resolve to `[]`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodeMieConfigOptions } from '../../../../env/types.js';

const getStoredCredentialsMock = vi.hoisted(() => vi.fn());
const fetchCodeMieLlmModelsMock = vi.hoisted(() => vi.fn());

vi.mock('../sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = getStoredCredentialsMock;
  },
}));

vi.mock('../sso.http-client.js', () => ({
  fetchCodeMieLlmModels: fetchCodeMieLlmModelsMock,
  fetchCodeMieIntegrations: vi.fn(),
  CODEMIE_ENDPOINTS: { USER_SETTINGS: '/v1/settings/user' },
}));

import { SSOModelProxy } from '../sso.models.js';

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
    getStoredCredentialsMock.mockReset();
    fetchCodeMieLlmModelsMock.mockReset();
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
      cookies: { codemie_access_token: 'fresh-cookie' },
    } as CodeMieConfigOptions;

    const models = await proxy.fetchModels(config);

    expect(models).toEqual([
      expect.objectContaining({ id: 'gpt-4o', name: 'GPT-4o' }),
    ]);
    expect(getStoredCredentialsMock).not.toHaveBeenCalled();
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
      cookies: { codemie_access_token: 'fresh-cookie' },
    } as CodeMieConfigOptions;

    await expect(proxy.fetchModels(config)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('falls back to stored credentials when no cookies are supplied', async () => {
    getStoredCredentialsMock.mockResolvedValue({
      apiUrl: 'https://codemie.example.com',
      cookies: { codemie_access_token: 'stored-cookie' },
    });
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      { deployment_name: 'gpt-4o', label: 'GPT-4o' },
    ]);

    const proxy = new SSOModelProxy();
    const models = await proxy.fetchModels(cfg({ codeMieUrl: 'https://codemie.example.com' }));

    expect(models).toHaveLength(1);
    expect(getStoredCredentialsMock).toHaveBeenCalled();
  });

  it('returns an empty array only for the genuine no-credentials-yet case', async () => {
    getStoredCredentialsMock.mockResolvedValue(null);

    const proxy = new SSOModelProxy();
    const models = await proxy.fetchModels(cfg({ codeMieUrl: 'https://codemie.example.com' }));

    expect(models).toEqual([]);
    expect(fetchCodeMieLlmModelsMock).not.toHaveBeenCalled();
  });

  it('propagates a real API failure from the stored-credentials fallback path too', async () => {
    getStoredCredentialsMock.mockResolvedValue({
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
      getStoredCredentialsMock.mockResolvedValue({ cookies: { s: '1' }, apiUrl: `${P}/code-assistant-api` });
      fetchCodeMieLlmModelsMock.mockResolvedValue([{ deployment_name: 'gpt-x', label: 'GPT X' }]);

      const models = await new SSOModelProxy().fetchModels({ provider: 'ai-run-sso', baseUrl: P } as CodeMieConfigOptions);

      expect(getStoredCredentialsMock).toHaveBeenCalledWith(P);
      expect(fetchCodeMieLlmModelsMock).toHaveBeenCalledWith(`${P}/code-assistant-api`, { s: '1' }, undefined);
      expect(models.map(m => m.id)).toEqual(['gpt-x']);
    });

    it('falls back to codeMieUrl when baseUrl misses', async () => {
      getStoredCredentialsMock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ cookies: { s: '1' }, apiUrl: `${P}/code-assistant-api` });
      fetchCodeMieLlmModelsMock.mockResolvedValue([{ deployment_name: 'gpt-x', label: 'GPT X' }]);

      const models = await new SSOModelProxy().fetchModels({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W } as CodeMieConfigOptions);

      expect(getStoredCredentialsMock.mock.calls.map(c => c[0])).toEqual([P, W]);
      // split host: the login stored under W was issued for the profile's API host
      expect(fetchCodeMieLlmModelsMock).toHaveBeenCalledWith(`${P}/code-assistant-api`, { s: '1' }, undefined);
      expect(models).toHaveLength(1);
    });
  });
});
