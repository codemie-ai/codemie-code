/**
 * Integration test for fetchAndBuildPiModels (src/agents/plugins/pi/pi.models.ts).
 *
 * CR-005: filterEntriesToProfile was previously only unit-tested in isolation
 * (pi.models.profile-filter.test.ts); this drives the real live-catalog
 * branch of fetchAndBuildPiModels - mocking only the network boundary
 * (fetchCodeMieLlmModels) and the filesystem (mkdir/writeFile) - so a wrong
 * env var or mis-ordered call between the enabled-filter, the convert step,
 * and filterEntriesToProfile would fail a test here.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { LlmModel } from '../../../../providers/plugins/sso/sso.http-client.js';

const writeFileMock = vi.fn().mockResolvedValue(undefined);
const mkdirMock = vi.fn().mockResolvedValue(undefined);
vi.mock('fs/promises', () => ({
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}));

const fetchCodeMieLlmModelsMock = vi.fn();
vi.mock('../../../../providers/plugins/sso/sso.http-client.js', () => ({
  fetchCodeMieLlmModels: fetchCodeMieLlmModelsMock,
}));

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const { fetchAndBuildPiModels } = await import('../pi.models.js');

function llmModel(id: string, enabled = true): LlmModel {
  return {
    deployment_name: id,
    base_name: id,
    label: id,
    enabled,
  } as LlmModel;
}

describe('fetchAndBuildPiModels — CODEMIE_PROFILE_MODELS narrowing (CR-005 integration)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function writtenModelIds(): string[] {
    const [, json] = writeFileMock.mock.calls[0];
    const config = JSON.parse(json as string);
    const ids: string[] = [];
    for (const provider of Object.values(config.providers) as Array<{ models: Array<{ id: string }> }>) {
      ids.push(...provider.models.map(m => m.id));
    }
    return ids;
  }

  it('narrows the written models.json to CODEMIE_PROFILE_MODELS, keeping the active model', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      llmModel('model-a'),
      llmModel('model-b'),
      llmModel('model-c'),
    ]);
    const env: NodeJS.ProcessEnv = {
      CODEMIE_JWT_TOKEN: 'jwt-token',
      CODEMIE_BASE_URL: 'http://localhost:1234',
      CODEMIE_MODEL: 'model-c',
      CODEMIE_PROFILE_MODELS: 'model-a,model-b',
    };

    await fetchAndBuildPiModels(env, '/work');

    expect(writtenModelIds().sort()).toEqual(['model-a', 'model-b', 'model-c']);
  });

  it('excludes disabled models and writes the full catalog when CODEMIE_PROFILE_MODELS is unset', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      llmModel('model-a'),
      llmModel('model-b', false),
    ]);
    const env: NodeJS.ProcessEnv = {
      CODEMIE_JWT_TOKEN: 'jwt-token',
      CODEMIE_BASE_URL: 'http://localhost:1234',
      CODEMIE_MODEL: 'model-a',
    };

    await fetchAndBuildPiModels(env, '/work');

    expect(writtenModelIds()).toEqual(['model-a']);
  });
});

describe('fetchAndBuildPiModels — compat.thinkingFormat schema (Pi 1.2.0)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Pi validates models.json against a closed enum and drops the WHOLE file on a mismatch,
  // which surfaces as `Unknown provider "codemie-proxy"`. 'reasoning_effort' was rejected in 1.2.0.
  const PI_THINKING_FORMATS = [
    'openai', 'openrouter', 'deepseek', 'together', 'baseten', 'zai', 'qwen',
    'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling',
  ];

  it('writes only thinkingFormat values Pi accepts, for every generated provider', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      llmModel('gpt-5-mini'),
      llmModel('claude-sonnet-4'),
    ]);
    const env: NodeJS.ProcessEnv = {
      CODEMIE_JWT_TOKEN: 'jwt-token',
      CODEMIE_BASE_URL: 'http://localhost:1234',
    };

    await fetchAndBuildPiModels(env, '/work');

    const [, json] = writeFileMock.mock.calls[0];
    const providers = JSON.parse(json as string).providers as Record<string, { compat: { thinkingFormat: string } }>;
    expect(Object.keys(providers).sort()).toEqual(['codemie-anthropic', 'codemie-proxy']);
    for (const provider of Object.values(providers)) {
      expect(PI_THINKING_FORMATS).toContain(provider.compat.thinkingFormat);
    }
  });
});
