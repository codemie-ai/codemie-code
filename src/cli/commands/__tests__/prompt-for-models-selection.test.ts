/**
 * Unit tests for promptForModelsSelection (src/cli/commands/setup.ts).
 *
 * promptForModelsSelection is the multi-select replacement for the old
 * single-choice promptForModelSelection: it lets the user check 2+ models,
 * re-prompts on an empty confirmation, folds "Custom model (manual entry)"
 * picks into the returned models array, and asks a follow-up "which model
 * should be active?" question only when 2+ models end up checked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock inquirer: queue-based prompt, records each call's questions.
const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({
  default: { prompt: promptMock }
}));

// --- Mock chalk so styling is a passthrough.
vi.mock('chalk', () => {
  const id = (s: string): string => s;
  const proxy = new Proxy(id, { get: () => id });
  return { default: proxy };
});

// --- Mock ora so no real spinner runs.
vi.mock('ora', () => ({
  default: () => ({ start: () => ({ succeed: () => {}, warn: () => {}, fail: () => {}, stop: () => {} }) })
}));

import { promptForModelsSelection } from '../setup.js';

function queueAnswers(answers: Array<Record<string, unknown>>): Record<string, unknown>[][] {
  const seenQuestions: Record<string, unknown>[][] = [];
  let i = 0;
  promptMock.mockImplementation(async (questions: Record<string, unknown>[]) => {
    seenQuestions.push(questions);
    return answers[i++] ?? {};
  });
  return seenQuestions;
}

describe('promptForModelsSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks a second "which model should be active?" prompt when 2+ models are checked', async () => {
    const seen = queueAnswers([
      { selectedModels: ['a', 'b'] },
      { activeModel: 'b' }
    ]);

    const result = await promptForModelsSelection(['a', 'b', 'c']);

    expect(result).toEqual({ models: ['a', 'b'], activeModel: 'b' });
    expect(promptMock).toHaveBeenCalledTimes(2);
    expect(seen[1][0].name).toBe('activeModel');
  });

  it('skips the second prompt when exactly one model is checked', async () => {
    const seen = queueAnswers([{ selectedModels: ['a'] }]);

    const result = await promptForModelsSelection(['a', 'b', 'c']);

    expect(result).toEqual({ models: ['a'], activeModel: 'a' });
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it('re-prompts the checkbox when the confirmed selection is empty', async () => {
    queueAnswers([
      { selectedModels: [] },
      { selectedModels: ['a'] }
    ]);

    const result = await promptForModelsSelection(['a', 'b', 'c']);

    expect(result).toEqual({ models: ['a'], activeModel: 'a' });
    expect(promptMock).toHaveBeenCalledTimes(2);
  });

  it('adds a custom-entered model id to the returned models alongside already-checked ids', async () => {
    queueAnswers([
      { selectedModels: ['a', 'custom'] },
      { customModel: 'my-custom-model' },
      { selectedModels: ['a', 'my-custom-model'] },
      { activeModel: 'my-custom-model' }
    ]);

    const result = await promptForModelsSelection(['a', 'b', 'c']);

    expect(result).toEqual({ models: ['a', 'my-custom-model'], activeModel: 'my-custom-model' });
  });

  it('pre-checks the checkbox choices from preselected on an update', async () => {
    const seen = queueAnswers([{ selectedModels: ['a'] }]);

    await promptForModelsSelection(['a', 'b', 'c'], undefined, undefined, undefined, ['a']);

    const checkboxQuestion = seen[0][0] as { choices: Array<{ value: string; checked?: boolean }> };
    const choiceA = checkboxQuestion.choices.find(c => c.value === 'a');
    expect(choiceA?.checked).toBe(true);
  });

  // CR-009: inquirer's checkbox can only return a value that is one of its
  // `choices`. A custom-entered or Ollama-searched id that never gains a
  // matching choice on the re-render can never actually be checked by a real
  // checkbox prompt - the previous "adds a custom-entered model id" test
  // above only proved the return value, not that the id was ever a
  // selectable choice (it is mocked at the inquirer level).
  it('adds the custom-entered model id as a real choice on the re-rendered checkbox (CR-009)', async () => {
    const seen = queueAnswers([
      { selectedModels: ['a', 'custom'] },
      { customModel: 'my-custom-model' },
      { selectedModels: ['a', 'my-custom-model'] },
      { activeModel: 'my-custom-model' }
    ]);

    await promptForModelsSelection(['a', 'b', 'c']);

    const secondCheckbox = seen[2][0] as { choices: Array<{ value: string }> };
    expect(secondCheckbox.choices.some(c => c.value === 'my-custom-model')).toBe(true);
  });

  it('adds the Ollama-searched model id as a real choice on the re-rendered checkbox (CR-009)', async () => {
    const setupSteps = { searchModel: vi.fn().mockResolvedValue('searched-model') };
    const seen = queueAnswers([
      { selectedModels: ['a', 'search'] },
      { selectedModels: ['a', 'searched-model'] },
      { activeModel: 'searched-model' }
    ]);

    await promptForModelsSelection(['a', 'b', 'c'], undefined, setupSteps, undefined);

    const secondCheckbox = seen[1][0] as { choices: Array<{ value: string }> };
    expect(secondCheckbox.choices.some(c => c.value === 'searched-model')).toBe(true);
  });

  // CR-010: the follow-up "which model should be active?" default must reflect
  // the profile's actual active model, not just the first still-checked id.
  it('defaults the active-model prompt to the profile\'s actual active model, not the first checked id (CR-010)', async () => {
    const seen = queueAnswers([
      { selectedModels: ['a', 'b'] },
      { activeModel: 'b' }
    ]);

    await promptForModelsSelection(['a', 'b', 'c'], undefined, undefined, undefined, ['a', 'b'], 'b');

    const activeModelQuestion = seen[1][0] as { default?: string };
    expect(activeModelQuestion.default).toBe('b');
  });

  it('falls back to the first still-checked preselected id when the actual active model is no longer checked (CR-010)', async () => {
    const seen = queueAnswers([
      { selectedModels: ['a', 'b'] },
      { activeModel: 'a' }
    ]);

    // preselectedActive 'x' was unchecked this round - fall back to preselected order.
    await promptForModelsSelection(['a', 'b', 'c'], undefined, undefined, undefined, ['a', 'b'], 'x');

    const activeModelQuestion = seen[1][0] as { default?: string };
    expect(activeModelQuestion.default).toBe('a');
  });

  describe('with a harness context (EPMCDME-15641)', () => {
    const ctx = { harnesses: ['claude', 'codex'] };

    it('accepts a compatible typed model silently on a catalog-less provider and asks for the uncovered harness', async () => {
      const seen = queueAnswers([
        { manualModel: 'claude-sonnet-4-5' },
        { manualModel: 'gpt-5.4' },
        { activeModel: 'gpt-5.4' }
      ]);

      const result = await promptForModelsSelection([], undefined, undefined, undefined, undefined, undefined, ctx);

      expect(result).toEqual({ models: ['claude-sonnet-4-5', 'gpt-5.4'], activeModel: 'gpt-5.4' });
      expect((seen[1][0] as { message: string }).message).toContain('codex');
    });

    it('warns and requires confirmation for a catalog-less model incompatible with every harness', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      queueAnswers([
        { manualModel: 'llama-3' },
        { confirmIncompatible: true }
      ]);

      const result = await promptForModelsSelection([], undefined, undefined, undefined, undefined, undefined, { harnesses: ['codex'] });

      expect(result).toEqual({ models: ['llama-3'], activeModel: 'llama-3', confirmedModels: ['llama-3'] });
    });

    it('labels active-model choices with the harnesses each model works with without restricting them', async () => {
      const seen = queueAnswers([
        { selectedModels: ['claude-sonnet-4-5', 'gpt-5.4'] },
        { activeModel: 'claude-sonnet-4-5' }
      ]);

      await promptForModelsSelection(['claude-sonnet-4-5', 'gpt-5.4'], undefined, undefined, undefined, undefined, undefined, ctx);

      const choices = (seen[1][0] as { choices: Array<{ name: string; value: string }> }).choices;
      expect(choices.map(c => c.value)).toEqual(['claude-sonnet-4-5', 'gpt-5.4']);
      expect(choices[0].name).toContain('claude');
      expect(choices[0].name).not.toContain('codex');
      expect(choices[1].name).toContain('codex');
    });
  });
});
