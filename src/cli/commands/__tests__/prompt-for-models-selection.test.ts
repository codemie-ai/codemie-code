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
});
