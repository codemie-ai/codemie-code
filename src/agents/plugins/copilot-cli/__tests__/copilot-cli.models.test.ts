import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LlmModel } from '../../../../providers/plugins/sso/sso.http-client.js';

const fetchCodeMieLlmModelsMock = vi.fn<() => Promise<LlmModel[]>>();

vi.mock('../../../../providers/plugins/sso/sso.http-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../providers/plugins/sso/sso.http-client.js')>();
  return {
    ...actual,
    fetchCodeMieLlmModels: fetchCodeMieLlmModelsMock,
  };
});

const storeMock = vi.hoisted(() => ({
  retrieveSSOCredentials: vi.fn(),
  retrieveJWTCredentials: vi.fn(async (): Promise<unknown> => null),
}));
// The SSO resolver reads stored logins from CredentialStore: per-URL cookie slot first, JWT slot
// second (both empty here unless a test seeds them).
vi.mock('../../../../utils/security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../utils/security.js')>()),
  CredentialStore: { getInstance: () => storeMock },
}));

function model(overrides: Partial<LlmModel>): LlmModel {
  return {
    base_name: overrides.base_name ?? overrides.deployment_name ?? overrides.label ?? 'unknown',
    deployment_name: overrides.deployment_name ?? overrides.base_name ?? overrides.label ?? 'unknown',
    label: overrides.label ?? overrides.deployment_name ?? overrides.base_name ?? 'unknown',
    enabled: overrides.enabled ?? true,
    provider: overrides.provider,
    default: overrides.default,
    features: {
      tools: true,
      streaming: true,
      ...overrides.features,
    },
  };
}

describe('copilot-cli model resolution', () => {
  beforeEach(() => {
    fetchCodeMieLlmModelsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists only GPT and Claude family models', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'gpt-5.5-2026-04-24' }),
      model({ deployment_name: 'claude-sonnet-4.6' }),
      model({ deployment_name: 'o4-mini', provider: 'openai' }),
      model({ deployment_name: 'codex-fast', provider: 'openai' }),
      model({ deployment_name: 'text-embedding-3-large' }),
      model({ deployment_name: 'gemini-2.5-pro' }),
    ]);

    const { resolveCopilotModel } = await import('../copilot-cli.models.js');
    const result = await resolveCopilotModel({
      CODEMIE_BASE_URL: 'https://api.codemie.example',
      CODEMIE_JWT_TOKEN: 'jwt-token',
    });

    expect(result.availableModels).toEqual(['gpt-5.5-2026-04-24', 'claude-sonnet-4.6']);
    expect(result.selectedModel).toBe('gpt-5.5-2026-04-24');
  });

  it('does not classify generic OpenAI, o-series, or standalone codex names as compatible', async () => {
    const { isCopilotCompatibleModelName } = await import('../copilot-cli.models.js');

    expect(isCopilotCompatibleModelName('gpt-5.4')).toBe(true);
    expect(isCopilotCompatibleModelName('claude-sonnet-5')).toBe(true);
    expect(isCopilotCompatibleModelName('openai-o4-mini')).toBe(false);
    expect(isCopilotCompatibleModelName('o3')).toBe(false);
    expect(isCopilotCompatibleModelName('codex-fast')).toBe(false);
  });

  it('rejects explicit non-GPT/non-Claude model overrides with Copilot-specific guidance', async () => {
    const { assertExplicitCopilotModelAllowed } = await import('../copilot-cli.models.js');

    expect(() => assertExplicitCopilotModelAllowed('o4-mini', ['gpt-5.5', 'claude-sonnet-4.6']))
      .toThrow(/GPT-family or Claude-family model/);
  });
});

describe('copilot-cli SSO lookup (profile baseUrl first)', () => {
  const creds = { cookies: { s: '1' }, apiUrl: 'https://api.sso.example/code-assistant-api' };
  const profile = JSON.stringify({ provider: 'ai-run-sso', baseUrl: 'https://profile.example.com' });

  beforeEach(() => {
    fetchCodeMieLlmModelsMock.mockReset();
    storeMock.retrieveSSOCredentials.mockReset();
    storeMock.retrieveJWTCredentials.mockReset();
    storeMock.retrieveJWTCredentials.mockResolvedValue(null);
  });

  it('fetches the catalog for a baseUrl-only profile with CODEMIE_URL unset', async () => {
    storeMock.retrieveSSOCredentials.mockResolvedValue(creds);
    fetchCodeMieLlmModelsMock.mockResolvedValue([model({ deployment_name: 'gpt-5.5-2026-04-24' })]);
    const { resolveCopilotModel } = await import('../copilot-cli.models.js');

    const result = await resolveCopilotModel({ CODEMIE_PROFILE_CONFIG: profile });

    expect(storeMock.retrieveSSOCredentials).toHaveBeenCalledWith('https://profile.example.com');
    expect(result.availableModels).toContain('gpt-5.5-2026-04-24');
  });

  it('ignores the proxy-rewritten CODEMIE_BASE_URL', async () => {
    storeMock.retrieveSSOCredentials.mockResolvedValue(creds);
    fetchCodeMieLlmModelsMock.mockResolvedValue([model({ deployment_name: 'gpt-5.5-2026-04-24' })]);
    const { resolveCopilotModel } = await import('../copilot-cli.models.js');

    await resolveCopilotModel({ CODEMIE_PROFILE_CONFIG: profile, CODEMIE_BASE_URL: 'http://localhost:4321' });

    expect(storeMock.retrieveSSOCredentials).toHaveBeenCalledWith('https://profile.example.com');
  });

  it('reports the resolved URL when SSO credentials are missing', async () => {
    storeMock.retrieveSSOCredentials.mockResolvedValue(null);
    const { resolveCopilotModel } = await import('../copilot-cli.models.js');

    await expect(resolveCopilotModel({ CODEMIE_PROFILE_CONFIG: profile })).rejects.toThrow(
      'codemie profile login --url https://profile.example.com'
    );
  });
});
