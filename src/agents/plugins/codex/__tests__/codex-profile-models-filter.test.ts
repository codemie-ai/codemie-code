/**
 * CODEMIE_PROFILE_MODELS narrowing of Codex's own available-model list
 * (src/agents/plugins/codex/codex-models.ts: filterAvailableModelsToProfile).
 *
 * codex.plugin.ts's setupProxy() calls this pure helper against each of its three
 * branches' computed id lists (SSO/JWT/Bedrock's resolveCodexModel().availableModels,
 * the Ollama branch's listModels() ids, and the LiteLLM branch's single configured
 * model) before writing env.CODEMIE_CODEX_AVAILABLE_MODELS. Pinning the helper here
 * avoids re-deriving each branch's heavier setup (network/proxy mocks) just to prove
 * the narrowing itself.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { filterAvailableModelsToProfile } from '../codex-models.js';
import { logger } from '../../../../utils/logger.js';

describe('filterAvailableModelsToProfile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('intersects with CODEMIE_PROFILE_MODELS when set (SSO/JWT/Bedrock-branch shape)', () => {
    const result = filterAvailableModelsToProfile(['a', 'b', 'c'], { CODEMIE_PROFILE_MODELS: 'a,b' });
    expect(result).toEqual(['a', 'b']);
  });

  it('returns the unfiltered list when CODEMIE_PROFILE_MODELS is unset', () => {
    const result = filterAvailableModelsToProfile(['a', 'b', 'c'], {});
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('intersects an Ollama-branch id list the same way', () => {
    const result = filterAvailableModelsToProfile(['llama3', 'qwen3', 'mistral'], {
      CODEMIE_PROFILE_MODELS: 'llama3,mistral',
    });
    expect(result).toEqual(['llama3', 'mistral']);
  });

  it('falls back to the unfiltered list when the intersection is empty (AC22)', () => {
    const result = filterAvailableModelsToProfile(['a', 'b'], { CODEMIE_PROFILE_MODELS: 'z,y' });
    expect(result).toEqual(['a', 'b']);
  });

  // CR-004: the fallback must also be logged, matching Claude/Pi's equivalent warn.
  it('logs a warning on the AC22 fallback (CR-004)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    filterAvailableModelsToProfile(['a', 'b'], { CODEMIE_PROFILE_MODELS: 'z,y' });

    expect(warnSpy).toHaveBeenCalled();
  });

  it('is a no-op on a single-model (LiteLLM-branch) list already matching the profile', () => {
    const result = filterAvailableModelsToProfile(['gpt-5-codex'], { CODEMIE_PROFILE_MODELS: 'gpt-5-codex' });
    expect(result).toEqual(['gpt-5-codex']);
  });

  // CR-003: setupProxy assigns env.CODEMIE_MODEL = resolution.selectedModel
  // immediately before calling this filter - the live active model must
  // survive the narrowing even when it falls outside CODEMIE_PROFILE_MODELS,
  // mirroring OpenCode's filterToAllowed and Pi's filterEntriesToProfile.
  it('keeps env.CODEMIE_MODEL in the result even when it is outside CODEMIE_PROFILE_MODELS (CR-003)', () => {
    const result = filterAvailableModelsToProfile(['a', 'b', 'c'], {
      CODEMIE_PROFILE_MODELS: 'b,c',
      CODEMIE_MODEL: 'a',
    });
    expect(result.sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not duplicate env.CODEMIE_MODEL when it is already in the intersection', () => {
    const result = filterAvailableModelsToProfile(['a', 'b', 'c'], {
      CODEMIE_PROFILE_MODELS: 'a,b',
      CODEMIE_MODEL: 'a',
    });
    expect(result).toEqual(['a', 'b']);
  });

  it('does not add env.CODEMIE_MODEL when it is not itself in availableModels', () => {
    const result = filterAvailableModelsToProfile(['a', 'b', 'c'], {
      CODEMIE_PROFILE_MODELS: 'b,c',
      CODEMIE_MODEL: 'not-in-list',
    });
    expect(result.sort()).toEqual(['b', 'c']);
  });
});
