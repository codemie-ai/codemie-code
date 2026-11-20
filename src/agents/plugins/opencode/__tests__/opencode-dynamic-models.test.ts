import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmModel } from '../../../../providers/plugins/sso/sso.http-client.js';

const fetchMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<LlmModel[]>>());
const storeMock = vi.hoisted(() => ({
  retrieveSSOCredentials: vi.fn(),
  retrieveJWTCredentials: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../providers/plugins/sso/sso.http-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../providers/plugins/sso/sso.http-client.js')>()),
  fetchCodeMieLlmModels: (...args: unknown[]) => fetchMock(...args),
}));
// The SSO resolver reads stored logins from CredentialStore: per-URL cookie slot first, JWT slot
// second (both empty here unless a test seeds them).
vi.mock('../../../../utils/security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../utils/security.js')>()),
  CredentialStore: { getInstance: () => storeMock },
}));

import { fetchDynamicModelConfigs } from '../opencode-dynamic-models.js';
import { OPENCODE_MODEL_CONFIGS } from '../opencode-model-configs.js';

const creds = { cookies: { s: '1' }, apiUrl: 'https://api.sso.example/code-assistant-api' };
const profile = JSON.stringify({ provider: 'ai-run-sso', baseUrl: 'https://profile.example.com' });
const proxyUrl = 'http://localhost:4321';

function llmModel(id: string): LlmModel {
  return {
    base_name: id,
    deployment_name: id,
    label: id,
    enabled: true,
    features: { tools: true, temperature: false },
    cost: { input: 0.000003, output: 0.000015 },
  };
}

describe('fetchDynamicModelConfigs', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    storeMock.retrieveSSOCredentials.mockReset();
    storeMock.retrieveJWTCredentials.mockReset();
    storeMock.retrieveJWTCredentials.mockResolvedValue(null);
  });

  it('resolves credentials for a baseUrl-only profile with CODEMIE_URL unset', async () => {
    storeMock.retrieveSSOCredentials.mockResolvedValue(creds);
    fetchMock.mockResolvedValue([llmModel('live-model-1')]);

    const result = await fetchDynamicModelConfigs(proxyUrl, { CODEMIE_PROFILE_CONFIG: profile });

    expect(storeMock.retrieveSSOCredentials).toHaveBeenCalledWith('https://profile.example.com');
    expect(fetchMock).toHaveBeenCalledWith(creds.apiUrl, creds.cookies, undefined);
    expect(Object.keys(result)).toEqual(['live-model-1']);
  });

  it('never uses the proxy-rewritten base URL for SSO credential lookup', async () => {
    storeMock.retrieveSSOCredentials.mockResolvedValue(creds);
    fetchMock.mockResolvedValue([llmModel('live-model-1')]);

    await fetchDynamicModelConfigs(proxyUrl, { CODEMIE_PROFILE_CONFIG: profile, CODEMIE_BASE_URL: proxyUrl });

    for (const [url] of storeMock.retrieveSSOCredentials.mock.calls) {
      expect(url).not.toContain('localhost');
    }
  });

  it('falls back to CODEMIE_URL when the profile config is absent', async () => {
    storeMock.retrieveSSOCredentials.mockResolvedValue(creds);
    fetchMock.mockResolvedValue([llmModel('live-model-1')]);

    await fetchDynamicModelConfigs(proxyUrl, { CODEMIE_URL: 'https://workspace.example.com' });

    expect(storeMock.retrieveSSOCredentials).toHaveBeenCalledWith('https://workspace.example.com');
  });

  it('narrows the catalog to CODEMIE_PROJECT', async () => {
    fetchMock.mockResolvedValue([llmModel('jwt-model')]);

    await fetchDynamicModelConfigs('https://jwt.example.com/api', {
      CODEMIE_JWT_TOKEN: 'tok',
      CODEMIE_PROJECT: 'router-demo',
    });

    expect(fetchMock).toHaveBeenCalledWith('https://jwt.example.com/api', 'tok', 'router-demo');
  });

  it('uses the JWT token against the given base URL when present', async () => {
    fetchMock.mockResolvedValue([llmModel('jwt-model')]);

    await fetchDynamicModelConfigs('https://jwt.example.com/api', { CODEMIE_JWT_TOKEN: 'tok' });

    expect(fetchMock).toHaveBeenCalledWith('https://jwt.example.com/api', 'tok', undefined);
    expect(storeMock.retrieveSSOCredentials).not.toHaveBeenCalled();
  });

  it('returns static configs when no credentials are stored', async () => {
    storeMock.retrieveSSOCredentials.mockResolvedValue(null);

    const result = await fetchDynamicModelConfigs(proxyUrl, { CODEMIE_PROFILE_CONFIG: profile });

    expect(result).toBe(OPENCODE_MODEL_CONFIGS);
  });

  it('returns static configs when the environment carries no auth info', async () => {
    const result = await fetchDynamicModelConfigs(proxyUrl, {});

    expect(result).toBe(OPENCODE_MODEL_CONFIGS);
    expect(storeMock.retrieveSSOCredentials).not.toHaveBeenCalled();
  });
});
