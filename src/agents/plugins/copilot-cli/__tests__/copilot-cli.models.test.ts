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
