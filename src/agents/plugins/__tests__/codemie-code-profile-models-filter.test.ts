/**
 * CODEMIE_PROFILE_MODELS narrowing of the generated OpenCode config's model list
 * for the built-in codemie-code agent (beforeRun lifecycle hook).
 *
 * Unlike codemie-code-reasoning.test.ts, this file does NOT mock
 * ../opencode/opencode-model-configs.js — it needs the real getChatCompletionsModelConfigs
 * and filterToAllowed so the profile-model narrowing actually takes effect on the
 * catalogue returned by the mocked fetchDynamicModelConfigs().
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OpenCodeModelConfig } from '../opencode/opencode-model-configs.js';

// Mock BaseAgentAdapter to avoid dependency tree
vi.mock('../../core/BaseAgentAdapter.js', () => ({
  BaseAgentAdapter: class {
    metadata: any;
    constructor(metadata: any) {
      this.metadata = metadata;
    }
  },
}));

vi.mock('../codemie-code-binary.js', () => ({
  resolveCodemieOpenCodeBinary: vi.fn(() => '/mock/bin/codemie'),
  getPlatformPackage: vi.fn(() => '@codemieai/codemie-opencode-darwin-arm64'),
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    notice: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setAgentName: vi.fn(),
    setSessionId: vi.fn(),
    setProfileName: vi.fn(),
  },
}));

vi.mock('../../../utils/processes.js', () => ({
  installGlobal: vi.fn(),
  uninstallGlobal: vi.fn(),
}));

const { mockProcessEvent } = vi.hoisted(() => ({ mockProcessEvent: vi.fn() }));
vi.mock('../../../cli/commands/hook.js', () => ({ processEvent: mockProcessEvent }));

vi.mock('../../../utils/paths.js', () => ({
  getCodemieHome: vi.fn(() => '/mock/.codemie'),
  getCodemiePath: vi.fn((...args: string[]) => `/mock/.codemie/${args.join('/')}`),
}));

vi.mock('../codemie-code-hooks/index.js', () => ({
  getHooksPluginFileUrl: vi.fn(() => 'file:///mock/hooks-plugin.js'),
  cleanupHooksPlugin: vi.fn(),
}));

vi.mock('../reasoning-sanitizer/index.js', () => ({
  getReasoningSanitizerPluginUrl: vi.fn(() => 'file:///mock/reasoning-sanitizer.ts'),
  cleanupReasoningSanitizerPlugin: vi.fn(),
}));

const { mockDiscoverSessions } = vi.hoisted(() => ({ mockDiscoverSessions: vi.fn() }));
vi.mock('../opencode/opencode.session.js', () => ({
  OpenCodeSessionAdapter: vi.fn(function () {
    return { discoverSessions: mockDiscoverSessions };
  }),
}));

function model(id: string): OpenCodeModelConfig {
  return {
    id,
    name: id,
    family: 'gpt-5',
    tool_call: true,
    reasoning: true,
    attachment: false,
    temperature: false,
    modalities: { input: ['text'], output: ['text'] },
    knowledge: '2025-08-31',
    release_date: '2025-12-11',
    last_updated: '2025-12-11',
    open_weights: false,
    cost: { input: 1, output: 1 },
    limit: { context: 1000, output: 1000 },
  };
}

// Three chat-completions-routed (use_responses_api falsy) models — only fetchDynamicModelConfigs
// is mocked, so the real getChatCompletionsModelConfigs + filterToAllowed run on this catalogue.
const CATALOGUE: Record<string, OpenCodeModelConfig> = {
  'model-a': model('model-a'),
  'model-b': model('model-b'),
  'model-c': model('model-c'),
};

vi.mock('../opencode/opencode-dynamic-models.js', () => ({
  fetchDynamicModelConfigs: vi.fn(() => Promise.resolve(CATALOGUE)),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const { CodeMieCodePluginMetadata } = await import('../codemie-code.plugin.js');

function createEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CODEMIE_PROVIDER: 'ai-run-sso',
    CODEMIE_BASE_URL: 'http://localhost:3000',
    CODEMIE_MODEL: 'model-a',
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}

function parseConfig(env: NodeJS.ProcessEnv): Record<string, any> {
  return JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
}

describe('CodeMie Code Plugin — CODEMIE_PROFILE_MODELS narrows the generated model list', () => {
  const beforeRun = CodeMieCodePluginMetadata.lifecycle!.beforeRun!;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscoverSessions.mockResolvedValue([]);
    mockProcessEvent.mockResolvedValue(undefined);
  });

  it('narrows the generated config to the profile models when CODEMIE_PROFILE_MODELS is set', async () => {
    const env = createEnv({ CODEMIE_PROFILE_MODELS: 'model-a,model-b' });
    await beforeRun(env, {} as any);

    const config = parseConfig(env);
    expect(Object.keys(config.provider['codemie-proxy'].models).sort()).toEqual(['model-a', 'model-b']);
  });

  it('keeps the full catalogue when CODEMIE_PROFILE_MODELS is unset', async () => {
    const env = createEnv();
    await beforeRun(env, {} as any);

    const config = parseConfig(env);
    expect(Object.keys(config.provider['codemie-proxy'].models).sort()).toEqual([
      'model-a', 'model-b', 'model-c',
    ]);
  });
});
