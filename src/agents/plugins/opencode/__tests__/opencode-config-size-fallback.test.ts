/**
 * Tests for the v2 config temp-file fallback.
 *
 * `injectV2Config()` prefers inline delivery through `OPENCODE_CONFIG_CONTENT`
 * and only falls back to a temp file referenced by `OPENCODE_CONFIG` once the
 * document exceeds the environment size limit. A v2 proxy config carries the
 * whole model catalogue, so the fallback is reachable in normal use, not only in
 * theory — and if it silently stopped working, large catalogues would be dropped
 * at launch with no error.
 *
 * The size limit is mocked down so the branch is reachable without a catalogue
 * large enough to overflow a real environment.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OpenCodeModelConfig } from '../opencode-model-configs.js';

const writeConfigToTempFile = vi.fn((_json: string, label: string) => `/tmp/${label}-config.json`);

vi.mock('../../../../cli/commands/hook.js', () => ({ processEvent: vi.fn() }));
vi.mock('../opencode.incremental-sync.js', () => ({
  startOpenCodeIncrementalSync: vi.fn(),
  stopOpenCodeIncrementalSync: vi.fn(),
}));
vi.mock('../opencode.paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../opencode.paths.js')>()),
  getOpenCodeDbPath: () => '/data/opencode/opencode.db',
  resolveOpenCodeDbPath: vi.fn(async () => '/data/opencode/opencode.db'),
}));
vi.mock('../../codemie-code-hooks/index.js', () => ({
  getHooksPluginFileUrl: () => 'file:///tmp/codemie-hooks/shell-hooks.ts',
  cleanupHooksPlugin: vi.fn(),
  getHooksV2PluginDirUrl: () => 'file:///tmp/codemie-hooks/shell-hooks-v2',
  cleanupHooksV2Plugin: vi.fn(),
}));
vi.mock('../opencode-dynamic-models.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../opencode-dynamic-models.js')>()),
  fetchDynamicModelConfigs: vi.fn(),
}));
vi.mock('../../../core/temp-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/temp-config.js')>()),
  MAX_ENV_SIZE: 64,
  writeConfigToTempFile,
}));

const { fetchDynamicModelConfigs } = await import('../opencode-dynamic-models.js');
const { MAX_ENV_SIZE } = await import('../../../core/temp-config.js');
const { OpenCodePluginMetadata } = await import('../opencode.plugin.js');

const ORIGINAL_OVERRIDE = process.env.CODEMIE_OPENCODE_CONFIG_VERSION;

function modelConfig(id: string): OpenCodeModelConfig {
  return {
    id,
    name: id,
    displayName: id,
    family: 'test',
    tool_call: true,
    reasoning: false,
    attachment: false,
    temperature: true,
    modalities: { input: ['text'], output: ['text'] },
    knowledge: '2026-01-01',
    release_date: '2026-01-01',
    last_updated: '2026-01-01',
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 128000, output: 4096 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CODEMIE_OPENCODE_CONFIG_VERSION = '2';
  vi.mocked(fetchDynamicModelConfigs).mockResolvedValue({
    'claude-4-5-sonnet': modelConfig('claude-4-5-sonnet'),
  });
});

afterEach(() => {
  if (ORIGINAL_OVERRIDE === undefined) {
    delete process.env.CODEMIE_OPENCODE_CONFIG_VERSION;
  } else {
    process.env.CODEMIE_OPENCODE_CONFIG_VERSION = ORIGINAL_OVERRIDE;
  }
});

describe('v2 config temp-file fallback', () => {
  it('is reachable because a v2 catalogue can exceed the env limit', () => {
    // Guards the premise of this file: if the mocked limit ever rises above the
    // emitted document, the fallback stops being exercised at all.
    const env: NodeJS.ProcessEnv = {
      CODEMIE_SESSION_ID: 'codemie-uuid-1',
      CODEMIE_AGENT: 'opencode',
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_URL: 'https://sso.example.com',
      CODEMIE_CLI_VERSION: '9.9.9',
      CODEMIE_MODEL: 'claude-4-5-sonnet',
      CODEMIE_BASE_URL: 'http://localhost:1234',
    };

    return OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never).then(() => {
      expect(JSON.stringify(env).length).toBeGreaterThan(MAX_ENV_SIZE);
    });
  });

  it('writes the config to a temp file and points OPENCODE_CONFIG at it', async () => {
    const env: NodeJS.ProcessEnv = {
      CODEMIE_SESSION_ID: 'codemie-uuid-1',
      CODEMIE_AGENT: 'opencode',
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_URL: 'https://sso.example.com',
      CODEMIE_CLI_VERSION: '9.9.9',
      CODEMIE_MODEL: 'claude-4-5-sonnet',
      CODEMIE_BASE_URL: 'http://localhost:1234',
    };

    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);

    expect(writeConfigToTempFile).toHaveBeenCalledTimes(1);
    const [json, label] = writeConfigToTempFile.mock.calls[0];
    expect(label).toBe('opencode-v2');
    expect(env.OPENCODE_CONFIG).toBe('/tmp/opencode-v2-config.json');
    // The temp file carries the full document; the inline channel must stay empty.
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(JSON.parse(json as string)).toMatchObject({ share: 'disabled' });
  });
});
