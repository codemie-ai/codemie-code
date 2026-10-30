/**
 * CODEMIE_PROFILE_MODELS narrowing of the OpenCode/codemie-code dynamic model
 * config map (src/agents/plugins/opencode/opencode-model-configs.ts: filterToAllowed).
 *
 * Both codemie-code.plugin.ts and opencode.plugin.ts call fetchDynamicModelConfigs()
 * to build the full live catalogue, then this filter narrows it down to the active
 * profile's own models before handing it to getChatCompletionsModelConfigs /
 * getResponsesApiModelConfigs — never dropping the currently selected model, and
 * falling back to the full catalogue on an empty intersection (AC22).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { filterToAllowed, type OpenCodeModelConfig } from '../opencode-model-configs.js';
import { logger } from '../../../../utils/logger.js';

function config(id: string): OpenCodeModelConfig {
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

describe('filterToAllowed', () => {
  const allModels: Record<string, OpenCodeModelConfig> = {
    a: config('a'),
    b: config('b'),
    c: config('c'),
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps only the ids in the allowed CSV list', () => {
    const result = filterToAllowed(allModels, 'a,b', 'a');
    expect(Object.keys(result).sort()).toEqual(['a', 'b']);
  });

  it('returns the unfiltered map when the allowed list has no overlap at all (AC22)', () => {
    const result = filterToAllowed(allModels, 'z', 'a');
    expect(result).toEqual(allModels);
  });

  // CR-004: the AC22 fallback must also be logged, matching Claude/Pi's
  // equivalent warn - OpenCode's fallback previously logged nothing at all.
  it('tells the user on the AC22 fallback (CR-004)', () => {
    const warnSpy = vi.spyOn(logger, 'notice').mockImplementation(() => {});

    filterToAllowed(allModels, 'z', 'a');

    expect(warnSpy).toHaveBeenCalled();
  });

  it('always keeps the selected model even if it is missing from the allowed CSV', () => {
    const result = filterToAllowed(allModels, 'b', 'a');
    expect(Object.keys(result).sort()).toEqual(['a', 'b']);
  });
});
