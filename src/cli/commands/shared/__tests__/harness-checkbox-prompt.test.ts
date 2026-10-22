import { describe, it, expect, vi } from 'vitest';

vi.mock('chalk', () => {
  const id = (s: string): string => s;
  const proxy = new Proxy(id, { get: () => id });
  return { default: proxy };
});

import { buildCoverageHint, HarnessCheckboxPrompt } from '../harness-checkbox-prompt.js';

describe('buildCoverageHint', () => {
  it('names every agent still missing a model', () => {
    expect(buildCoverageHint(['codex', 'gemini'])).toContain('Still missing a model for: codex, gemini');
  });

  it('confirms coverage when no agent is missing', () => {
    expect(buildCoverageHint([])).toContain('Every selected agent has a model');
  });
});

describe('HarnessCheckboxPrompt', () => {
  it('computes the missing agents from the checked values and puts the hint under the question line', () => {
    const rendered: string[] = [];
    const choices = [
      { value: 'a', name: 'a', checked: true },
      { value: 'b', name: 'b', checked: false },
      { type: 'separator' }
    ];
    const prompt = Object.create(HarnessCheckboxPrompt.prototype) as HarnessCheckboxPrompt & Record<string, unknown>;
    prompt.status = 'pending';
    prompt.opt = {
      choices,
      missingFor: (checked: string[]) => (checked.includes('b') ? [] : ['codex'])
    };
    prompt.screen = { render: (content: string) => { rendered.push(content); } };
    // The inherited render needs the full inquirer runtime; stub the parent to emit a question + choices.
    const parent = Object.getPrototypeOf(HarnessCheckboxPrompt.prototype) as { render: (e?: string) => void };
    const spy = vi.spyOn(parent, 'render').mockImplementation(function (this: { screen: { render: (c: string, b: string) => void } }) {
      this.screen.render('? Question\nrow-a\nrow-b', '');
    });

    prompt.render();

    expect(rendered[0].split('\n')[0]).toBe('? Question');
    expect(rendered[0].split('\n')[1]).toContain('Still missing a model for: codex');
    spy.mockRestore();
  });
});
