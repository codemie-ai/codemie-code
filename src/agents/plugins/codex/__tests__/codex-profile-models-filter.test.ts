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

import { describe, it, expect } from 'vitest';
import { filterAvailableModelsToProfile } from '../codex-models.js';

describe('filterAvailableModelsToProfile', () => {
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

  it('is a no-op on a single-model (LiteLLM-branch) list already matching the profile', () => {
    const result = filterAvailableModelsToProfile(['gpt-5-codex'], { CODEMIE_PROFILE_MODELS: 'gpt-5-codex' });
    expect(result).toEqual(['gpt-5-codex']);
  });
});
