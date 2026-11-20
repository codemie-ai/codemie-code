/**
 * Integration tests for CodexPlugin's setupProxy — the three branches
 * (Ollama, LiteLLM, default SSO/JWT/Bedrock) that each call
 * filterAvailableModelsToProfile before writing
 * env.CODEMIE_CODEX_AVAILABLE_MODELS.
 *
 * CR-005: previously only the pure filterAvailableModelsToProfile helper
 * (codex-profile-models-filter.test.ts) was unit-tested in isolation; these
 * drive the real setupProxy call site, with resolveCodexModel/OllamaModelProxy
 * mocked at the network boundary but filterAvailableModelsToProfile itself
 * kept real, so a wrong env var, swapped argument, or mis-ordered call would
 * fail a test here.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const resolveCodexModelMock = vi.fn();
vi.mock('../codex-models.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codex-models.js')>();
  return { ...actual, resolveCodexModel: resolveCodexModelMock };
});

const listModelsMock = vi.fn();
vi.mock('../../../../providers/plugins/ollama/ollama.models.js', () => ({
  OllamaModelProxy: class {
    listModels = listModelsMock;
  },
}));

const { CodexPlugin } = await import('../codex.plugin.js');

describe("CodexPlugin.setupProxy — CODEMIE_PROFILE_MODELS narrowing (CR-005 integration)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('narrows CODEMIE_CODEX_AVAILABLE_MODELS on the default (SSO/JWT/Bedrock) branch, keeping the active model', async () => {
    resolveCodexModelMock.mockResolvedValue({
      selectedModel: 'model-c',
      availableModels: ['model-a', 'model-b', 'model-c'],
      catalogPath: undefined,
    });
    // 'bedrock' has authType 'api-key' (not sso/jwt), so super.setupProxy's
    // shouldUseProxy() is false and no real CodeMieProxy is started.
    const plugin = new CodexPlugin();
    const env: NodeJS.ProcessEnv = {
      CODEMIE_PROVIDER: 'bedrock',
      CODEMIE_PROFILE_MODELS: 'model-a,model-b',
    };

    await (plugin as unknown as { setupProxy: (env: NodeJS.ProcessEnv) => Promise<void> }).setupProxy(env);

    expect(env.CODEMIE_MODEL).toBe('model-c');
    expect(env.CODEMIE_CODEX_AVAILABLE_MODELS!.split(',').sort()).toEqual(['model-a', 'model-b', 'model-c']);
  });

  it('narrows the Ollama-branch id list the same way', async () => {
    listModelsMock.mockResolvedValue([{ id: 'llama3' }, { id: 'qwen3' }, { id: 'mistral' }]);
    const plugin = new CodexPlugin();
    const env: NodeJS.ProcessEnv = {
      CODEMIE_PROVIDER: 'ollama',
      CODEMIE_MODEL: 'llama3',
      CODEMIE_PROFILE_MODELS: 'llama3,mistral',
    };

    await (plugin as unknown as { setupProxy: (env: NodeJS.ProcessEnv) => Promise<void> }).setupProxy(env);

    expect(env.CODEMIE_CODEX_AVAILABLE_MODELS!.split(',').sort()).toEqual(['llama3', 'mistral']);
  });

  it('narrows the single-model LiteLLM branch the same way', async () => {
    const plugin = new CodexPlugin();
    const env: NodeJS.ProcessEnv = {
      CODEMIE_PROVIDER: 'litellm',
      CODEMIE_MODEL: 'gpt-5-codex',
      CODEMIE_PROFILE_MODELS: 'gpt-5-codex',
    };

    await (plugin as unknown as { setupProxy: (env: NodeJS.ProcessEnv) => Promise<void> }).setupProxy(env);

    expect(env.CODEMIE_CODEX_AVAILABLE_MODELS).toBe('gpt-5-codex');
  });
});
