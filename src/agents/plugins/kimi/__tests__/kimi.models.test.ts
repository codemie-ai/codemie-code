/**
 * Kimi model resolution/validation.
 *
 * Pins the pure compatibility filter, the ranking used by resolveKimiModel
 * (k2.6 > k2 > version parts > tool/streaming/default bonuses), the fallbacks
 * when the catalog fetch fails or returns nothing compatible, and the explicit
 * allow-list guard. The catalog fetch is mocked — no network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LlmModel } from '../../../../providers/plugins/sso/sso.http-client.js';

// Mock the catalog fetch so resolveKimiModel never hits the network.
// Proven repo pattern (copilot-cli.models.test.ts / gemini.models.test.ts):
// spread the original module and replace only fetchCodeMieLlmModels.
const fetchMock = vi.hoisted(() => vi.fn<() => Promise<LlmModel[]>>());
vi.mock('../../../../providers/plugins/sso/sso.http-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../providers/plugins/sso/sso.http-client.js')>();
  return { ...actual, fetchCodeMieLlmModels: fetchMock };
});

import {
  assertExplicitKimiDeploymentAllowed,
  isKimiCompatibleModelName,
  resolveKimiModel,
  assertExplicitKimiModelAllowed,
} from '../kimi.models.js';

/** Minimal LlmModel factory (only the fields the reader touches). */
function model(fields: Partial<LlmModel>): LlmModel {
  return { enabled: true, ...fields } as unknown as LlmModel;
}

// JWT-auth env makes fetchCodeMieModelsForKimi call fetchCodeMieLlmModels directly.
const baseEnv = { CODEMIE_JWT_TOKEN: 'tok', CODEMIE_BASE_URL: 'https://x/code-assistant-api' };

describe('isKimiCompatibleModelName', () => {
  it('accepts kimi/moonshot names', () => {
    expect(isKimiCompatibleModelName('kimi-k2')).toBe(true);
    expect(isKimiCompatibleModelName('kimi-k2-thinking')).toBe(true);
    expect(isKimiCompatibleModelName('moonshot-v1-8k')).toBe(true);
    expect(isKimiCompatibleModelName('moonshotai/kimi-k2')).toBe(true);
  });

  it('rejects other providers, empty and undefined', () => {
    expect(isKimiCompatibleModelName('claude-sonnet-4-6')).toBe(false);
    expect(isKimiCompatibleModelName('gpt-5')).toBe(false);
    expect(isKimiCompatibleModelName('gemini-3-pro')).toBe(false);
    expect(isKimiCompatibleModelName('qwen-max')).toBe(false);
    expect(isKimiCompatibleModelName('deepseek-v3')).toBe(false);
    expect(isKimiCompatibleModelName(undefined)).toBe(false);
    expect(isKimiCompatibleModelName('')).toBe(false);
  });

  it('rejects an incompatible token even if it also contains "kimi"', () => {
    // INCOMPATIBLE patterns are checked before the compatible ones.
    expect(isKimiCompatibleModelName('kimi-claude-hybrid')).toBe(false);
  });
});

describe('resolveKimiModel - compatibility filter', () => {
  beforeEach(() => fetchMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('keeps kimi/moonshot deployments and drops claude/gpt/gemini', async () => {
    fetchMock.mockResolvedValue([
      model({ deployment_name: 'kimi-k2', base_name: 'kimi-k2', label: 'Kimi K2', provider: 'moonshot' }),
      model({ deployment_name: 'moonshot-v1-8k', base_name: 'moonshot-v1-8k', label: 'Moonshot v1 8k', provider: 'moonshot' }),
      model({ deployment_name: 'claude-sonnet-4-6', base_name: 'claude-sonnet-4-6', label: 'Claude', provider: 'anthropic' }),
      model({ deployment_name: 'gpt-5', base_name: 'gpt-5', label: 'GPT 5', provider: 'openai' }),
      model({ deployment_name: 'gemini-3-pro', base_name: 'gemini-3-pro', label: 'Gemini', provider: 'google' }),
    ]);

    const res = await resolveKimiModel({ ...baseEnv });
    expect(res.availableModels).toContain('kimi-k2');
    expect(res.availableModels).toContain('moonshot-v1-8k');
    expect(res.availableModels).not.toContain('claude-sonnet-4-6');
    expect(res.availableModels).not.toContain('gpt-5');
    expect(res.availableModels).not.toContain('gemini-3-pro');
    expect(res.availableModels).toHaveLength(2);
  });

  it('drops disabled deployments', async () => {
    fetchMock.mockResolvedValue([
      model({ enabled: false, deployment_name: 'kimi-k2', base_name: 'kimi-k2', label: 'Kimi K2', provider: 'moonshot' }),
      model({ deployment_name: 'moonshot-v1-8k', base_name: 'moonshot-v1-8k', label: 'Moonshot', provider: 'moonshot' }),
    ]);

    const res = await resolveKimiModel({ ...baseEnv });
    expect(res.availableModels).toEqual(['moonshot-v1-8k']);
  });
});

describe('resolveKimiModel - ranking', () => {
  beforeEach(() => fetchMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('prefers a k2.6 deployment over plain k2 and moonshot', async () => {
    fetchMock.mockResolvedValue([
      model({ deployment_name: 'moonshot-v1-8k', base_name: 'moonshot-v1-8k', label: 'Moonshot', provider: 'moonshot' }),
      model({ deployment_name: 'kimi-k2', base_name: 'kimi-k2', label: 'Kimi K2', provider: 'moonshot' }),
      model({ deployment_name: 'kimi-k2-6', base_name: 'kimi-k2-6', label: 'Kimi K2.6', provider: 'moonshot' }),
    ]);

    const res = await resolveKimiModel({ ...baseEnv });
    expect(res.selectedModel).toBe('kimi-k2-6');
    // full ranked ordering is exposed via availableModels
    expect(res.availableModels[0]).toBe('kimi-k2-6');
  });

  it('prefers any k2 over a non-k2 kimi/moonshot model', async () => {
    fetchMock.mockResolvedValue([
      model({ deployment_name: 'moonshot-v1-8k', base_name: 'moonshot-v1-8k', label: 'Moonshot', provider: 'moonshot' }),
      model({ deployment_name: 'kimi-k2-0905', base_name: 'kimi-k2-0905', label: 'Kimi K2 0905', provider: 'moonshot' }),
    ]);

    const res = await resolveKimiModel({ ...baseEnv });
    expect(res.selectedModel).toBe('kimi-k2-0905');
  });

  it('ranks higher version parts ahead among k2 deployments', async () => {
    fetchMock.mockResolvedValue([
      model({ deployment_name: 'kimi-k2-0711', base_name: 'kimi-k2-0711', label: 'Kimi K2 0711', provider: 'moonshot' }),
      model({ deployment_name: 'kimi-k2-0905', base_name: 'kimi-k2-0905', label: 'Kimi K2 0905', provider: 'moonshot' }),
    ]);

    const res = await resolveKimiModel({ ...baseEnv });
    expect(res.selectedModel).toBe('kimi-k2-0905');
    expect(res.availableModels).toEqual(['kimi-k2-0905', 'kimi-k2-0711']);
  });

  it('breaks a full tie by ascending model id (deterministic)', async () => {
    fetchMock.mockResolvedValue([
      model({ deployment_name: 'kimi-k2-zeta', base_name: 'kimi-k2-zeta', label: 'Kimi K2', provider: 'moonshot' }),
      model({ deployment_name: 'kimi-k2-alpha', base_name: 'kimi-k2-alpha', label: 'Kimi K2', provider: 'moonshot' }),
    ]);

    const res = await resolveKimiModel({ ...baseEnv });
    expect(res.availableModels).toEqual(['kimi-k2-alpha', 'kimi-k2-zeta']);
  });
});

describe('resolveKimiModel - fallbacks', () => {
  beforeEach(() => fetchMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('keeps a compatible configured model when the fetch fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const res = await resolveKimiModel({ ...baseEnv, CODEMIE_MODEL: 'kimi-k2' });
    expect(res).toEqual({ selectedModel: 'kimi-k2', availableModels: ['kimi-k2'] });
  });

  it('re-throws the fetch error when the configured model is not kimi-compatible', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(resolveKimiModel({ ...baseEnv, CODEMIE_MODEL: 'gpt-5' }))
      .rejects.toThrow(/network down/);
  });

  it('keeps a compatible configured model when the catalog has no kimi models', async () => {
    fetchMock.mockResolvedValue([
      model({ deployment_name: 'gpt-5', base_name: 'gpt-5', label: 'GPT 5', provider: 'openai' }),
    ]);
    const res = await resolveKimiModel({ ...baseEnv, CODEMIE_MODEL: 'kimi-k2' });
    expect(res).toEqual({ selectedModel: 'kimi-k2', availableModels: ['kimi-k2'] });
  });

  it('throws a clear error when the catalog is empty and no compatible model is configured', async () => {
    fetchMock.mockResolvedValue([]);
    await expect(resolveKimiModel({ ...baseEnv }))
      .rejects.toThrow(/No CodeMie Kimi model is available/i);
  });

  it('returns [] with no auth env and throws (nothing configured, empty catalog)', async () => {
    // No JWT/SSO env -> fetchCodeMieModelsForKimi returns [] without calling fetch.
    await expect(resolveKimiModel({}))
      .rejects.toThrow(/No CodeMie Kimi model is available/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('assertExplicitKimiModelAllowed', () => {
  const avail = ['kimi-k2', 'kimi-k2-0905'];

  it('passes for a compatible, available model', () => {
    expect(() => assertExplicitKimiModelAllowed('kimi-k2', avail)).not.toThrow();
  });

  it('throws for an incompatible model', () => {
    expect(() => assertExplicitKimiModelAllowed('gpt-5', avail)).toThrow(/not compatible with codemie-kimi/i);
    expect(() => assertExplicitKimiModelAllowed('gpt-5', avail)).toThrow(/kimi-k2/);
  });

  it('throws for a compatible-but-unavailable model, listing what is available', () => {
    expect(() => assertExplicitKimiModelAllowed('kimi-k2-9999', avail)).toThrow(/not available in CodeMie/i);
    expect(() => assertExplicitKimiModelAllowed('kimi-k2-9999', avail)).toThrow(/kimi-k2-0905/);
  });

  it('skips the availability check when the list is empty (cannot adjudicate)', () => {
    expect(() => assertExplicitKimiModelAllowed('kimi-k2', [])).not.toThrow();
  });
});

describe('assertExplicitKimiDeploymentAllowed', () => {
  it('allows arbitrary Azure deployment IDs when discovery returns them', () => {
    expect(() => assertExplicitKimiDeploymentAllowed('production-chat', ['production-chat']))
      .not.toThrow();
    expect(() => assertExplicitKimiDeploymentAllowed('missing-chat', ['production-chat']))
      .toThrow(/not available/);
  });
});
