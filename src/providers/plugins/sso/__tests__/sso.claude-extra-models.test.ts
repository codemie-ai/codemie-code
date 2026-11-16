/**
 * Non-Claude models a profile opts into for the Claude clients (`claudeExtraModels`).
 * @group unit
 */
import { describe, expect, it } from 'vitest';
import type { LlmModel } from '../sso.http-client.js';
import {
  catalogModelId,
  catalogModelIdentifiers,
  claudeExtraModelsFromEnv,
  isServableCatalogModel,
  listClaudeExtraModelCandidates,
  readClaudeExtraModels,
  resolveClaudeExtraModels,
} from '../sso.claude-extra-models.js';

function model(overrides: Partial<LlmModel>): LlmModel {
  const id = overrides.deployment_name ?? overrides.base_name ?? 'unknown';
  return {
    base_name: overrides.base_name ?? id,
    deployment_name: id,
    label: overrides.label ?? id,
    enabled: overrides.enabled ?? true,
    ...overrides,
  };
}

const grok = model({ deployment_name: 'grok-4.6', label: 'Grok 4.6' });
const gemini = model({ deployment_name: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' });
const sonnet = model({ deployment_name: 'claude-sonnet-5', label: 'Claude Sonnet 5' });

describe('isServableCatalogModel', () => {
  it('accepts an enabled chat model', () => {
    expect(isServableCatalogModel(grok)).toBe(true);
  });

  it('rejects a disabled model', () => {
    expect(isServableCatalogModel(model({ deployment_name: 'grok-4.6', enabled: false }))).toBe(false);
  });

  it('rejects a model without tool use or streaming', () => {
    expect(isServableCatalogModel(model({ deployment_name: 'gpt-x', features: { tools: false } }))).toBe(false);
    expect(isServableCatalogModel(model({ deployment_name: 'gpt-y', features: { streaming: false } }))).toBe(false);
  });

  it.each(['text-embedding-3', 'cohere-rerank', 'whisper-1', 'gpt-image-1'])('rejects the non-chat model %s', (id) => {
    expect(isServableCatalogModel(model({ deployment_name: id }))).toBe(false);
  });
});

describe('catalogModelIdentifiers / catalogModelId', () => {
  it('lists the deployment name, base name and label', () => {
    const entry = model({ deployment_name: 'gpt-5-2025-08-07', base_name: 'gpt-5', label: 'GPT-5' });
    expect(catalogModelIdentifiers(entry)).toEqual(['gpt-5-2025-08-07', 'gpt-5', 'GPT-5']);
  });

  it('stores a model under its deployment name', () => {
    expect(catalogModelId(model({ deployment_name: 'gpt-5-2025-08-07', base_name: 'gpt-5' }))).toBe('gpt-5-2025-08-07');
  });
});

describe('listClaudeExtraModelCandidates', () => {
  it('offers servable non-Claude models only, sorted by name', () => {
    const embedding = model({ deployment_name: 'text-embedding-3', label: 'Embedding' });
    expect(listClaudeExtraModelCandidates([sonnet, grok, embedding, gemini])).toEqual([gemini, grok]);
  });

  it('lists a model registered twice once', () => {
    expect(listClaudeExtraModelCandidates([grok, { ...grok }])).toHaveLength(1);
  });
});

describe('resolveClaudeExtraModels', () => {
  it('returns the stored models the catalog still serves, in stored order', () => {
    expect(resolveClaudeExtraModels([grok, gemini], ['gemini-3.1-pro', 'grok-4.6'])).toEqual([gemini, grok]);
  });

  it('skips a stored ID the catalog no longer serves', () => {
    expect(resolveClaudeExtraModels([grok], ['gemini-3.1-pro', 'grok-4.6'])).toEqual([grok]);
  });

  it('matches a stored ID by any catalog identifier', () => {
    expect(resolveClaudeExtraModels([grok], ['Grok 4.6'])).toEqual([grok]);
  });

  it('skips a model the catalog lists but cannot serve', () => {
    expect(resolveClaudeExtraModels([{ ...grok, enabled: false }], ['grok-4.6'])).toEqual([]);
  });
});

describe('readClaudeExtraModels', () => {
  it('keeps non-empty strings only', () => {
    expect(readClaudeExtraModels({ claudeExtraModels: ['grok-4.6', '', '  ', 7 as unknown as string] })).toEqual(['grok-4.6']);
  });

  it('returns nothing for a missing profile or field', () => {
    expect(readClaudeExtraModels(undefined)).toEqual([]);
    expect(readClaudeExtraModels({})).toEqual([]);
  });
});

describe('claudeExtraModelsFromEnv', () => {
  it('reads the list from the launched profile config', () => {
    const env = { CODEMIE_PROFILE_CONFIG: JSON.stringify({ claudeExtraModels: ['grok-4.6'] }) };
    expect(claudeExtraModelsFromEnv(env)).toEqual(['grok-4.6']);
  });

  it('returns nothing when the profile config is absent or not JSON', () => {
    expect(claudeExtraModelsFromEnv({})).toEqual([]);
    expect(claudeExtraModelsFromEnv({ CODEMIE_PROFILE_CONFIG: '{oops' })).toEqual([]);
  });
});
