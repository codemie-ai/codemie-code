/**
 * Checkbox prompt that re-labels its rows as the selection changes.
 *
 * Used by the setup model step: each row names the agents the model works with, and agents that
 * no currently checked model covers are highlighted. A two-line hint under the question explains
 * the highlight and names the agents still missing a model.
 *
 * inquirer's stock checkbox renders static choice names, so this subclasses it and refreshes the
 * names (and the hint) right before every render.
 */

import chalk from 'chalk';
import CheckboxPrompt from 'inquirer/lib/prompts/checkbox.js';

export const HARNESS_CHECKBOX_PROMPT = 'harness-checkbox';

/** Extra question options read by {@link HarnessCheckboxPrompt}. */
export interface HarnessCheckboxOptions {
  /** Agents with no checked model, given the currently checked choice values. */
  missingFor: (checked: string[]) => string[];
  /** Full row text for a choice given the agents still missing; undefined keeps the row as is. */
  liveLabel: (value: string, missing: string[]) => string | undefined;
}

/** Two-line hint shown under the question. */
export function buildCoverageHint(missing: string[]): string {
  const legend = chalk.dim('Agents shown with a highlight in [brackets] have no selected model yet.');
  const status = missing.length > 0
    ? chalk.yellow(`Still missing a model for: ${missing.join(', ')}`)
    : chalk.green('✓ Every selected agent has a model.');
  return `  ${legend}\n  ${status}`;
}

interface PromptChoice {
  type?: string;
  value?: unknown;
  name?: string;
  checked?: boolean;
  disabled?: boolean | string;
}

export class HarnessCheckboxPrompt extends (CheckboxPrompt as new (...args: unknown[]) => any) {
  private missing: string[] = [];

  private refresh(): void {
    const opt = this.opt as unknown as HarnessCheckboxOptions & { choices: { forEach: (fn: (c: PromptChoice) => void) => void } };
    const checked: string[] = [];
    opt.choices.forEach((choice: PromptChoice) => {
      if (choice.type !== 'separator' && choice.checked && !choice.disabled && typeof choice.value === 'string') {
        checked.push(choice.value);
      }
    });
    this.missing = opt.missingFor(checked);
    opt.choices.forEach((choice: PromptChoice) => {
      if (choice.type === 'separator' || typeof choice.value !== 'string') return;
      const name = opt.liveLabel(choice.value, this.missing);
      if (name !== undefined) choice.name = name;
    });
  }

  render(error?: string): void {
    if (this.status === 'answered') {
      super.render(error);
      return;
    }
    this.refresh();
    const screen = this.screen;
    const original = screen.render.bind(screen);
    const hint = buildCoverageHint(this.missing);
    screen.render = (content: string, bottom: string): void => {
      const firstBreak = content.indexOf('\n');
      original(firstBreak === -1 ? content : `${content.slice(0, firstBreak)}\n${hint}${content.slice(firstBreak)}`, bottom);
    };
    try {
      super.render(error);
    } finally {
      screen.render = original;
    }
  }
}
