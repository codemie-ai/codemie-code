/**
 * Checkbox prompt with a live coverage line under the question.
 *
 * Used by the setup model step: as models are checked and unchecked, the line names the selected
 * agents that no checked model covers yet (or confirms every agent has one).
 *
 * inquirer's stock checkbox renders a static question, so this subclasses it and injects the line
 * right before every render.
 */

import chalk from 'chalk';
import CheckboxPrompt from 'inquirer/lib/prompts/checkbox.js';

export const HARNESS_CHECKBOX_PROMPT = 'harness-checkbox';

/** Extra question options read by {@link HarnessCheckboxPrompt}. */
export interface HarnessCheckboxOptions {
  /** Agents with no checked model, given the currently checked choice values. */
  missingFor: (checked: string[]) => string[];
}

/** One-line status shown under the question. */
export function buildCoverageHint(missing: string[]): string {
  const status = missing.length > 0
    ? chalk.yellow(`Still missing a model for: ${missing.join(', ')}`)
    : chalk.green('\u2713 Every selected agent has a model.');
  return `  ${status}`;
}

interface PromptChoice {
  type?: string;
  value?: unknown;
  checked?: boolean;
  disabled?: boolean | string;
}

export class HarnessCheckboxPrompt extends (CheckboxPrompt as new (...args: unknown[]) => any) {
  private currentMissing(): string[] {
    const opt = this.opt as unknown as HarnessCheckboxOptions & { choices: { forEach: (fn: (c: PromptChoice) => void) => void } };
    const checked: string[] = [];
    opt.choices.forEach((choice: PromptChoice) => {
      if (choice.type !== 'separator' && choice.checked && !choice.disabled && typeof choice.value === 'string') {
        checked.push(choice.value);
      }
    });
    return opt.missingFor(checked);
  }

  render(error?: string): void {
    if (this.status === 'answered') {
      super.render(error);
      return;
    }
    const screen = this.screen;
    const original = screen.render.bind(screen);
    const hint = buildCoverageHint(this.currentMissing());
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
