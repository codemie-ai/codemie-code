import chalk from 'chalk';
import inquirer from 'inquirer';
import type { AllowlistState } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';

/** `enable` applies the analytics configuration; `cancel` covers Decline and a closed prompt. */
export type AnalyticsConfirmationResult = 'enable' | 'cancel';

/** Inputs that determine the wording of the analytics confirmation prompt. */
export interface AnalyticsConfirmationOptions {
  /** Profile the analytics will be sent through, shown in the header. */
  profile: string;
  /** CodeMie URL of that profile, shown in the header only when configured. */
  codeMieUrl?: string;
  /** Current state of the Claude Code project allowlist; only used to warn when it cannot be read. */
  allowlist: AllowlistState;
  /** Analytics project name of the current project; set only for project scope, where it is shown. */
  projectName?: string;
}

const INVALID_ALLOWLIST_NOTE = 'The project list in Claude Code settings cannot be read and will be replaced.';

/**
 * Show the analytics confirmation and wait for the user's decision. The details
 * are printed first, then the same inquirer list used by `codemie setup` asks
 * Confirm / Decline. A closed prompt resolves to `cancel` so the caller leaves the
 * allowlist and daemon untouched. Callers must gate on an interactive terminal.
 */
export async function promptAnalyticsConfirmation(
  options: AnalyticsConfirmationOptions,
): Promise<AnalyticsConfirmationResult> {
  console.log(buildAnalyticsConfirmationMessage(options));

  try {
    const { enable } = await inquirer.prompt<{ enable: boolean }>([
      {
        type: 'list',
        name: 'enable',
        message: 'Enable Claude Code analytics?',
        choices: [
          { name: 'Confirm', value: true },
          { name: 'Decline', value: false },
        ],
      },
    ]);
    return enable ? 'enable' : 'cancel';
  } catch (error) {
    if (error instanceof Error && (error.name === 'ExitPromptError' || error.name === 'AbortPromptError')) {
      return 'cancel';
    }
    throw error;
  }
}

/**
 * Render the text shown above the choice list (pure, so it is testable without a TTY):
 * profile, CodeMie URL, the project name for project scope, and a note when the
 * project allowlist cannot be read.
 */
export function buildAnalyticsConfirmationMessage(options: AnalyticsConfirmationOptions): string {
  const lines = [
    chalk.cyan(`Using profile: ${options.profile}`),
    ...buildAnalyticsDetailLines(options),
  ];

  if (options.allowlist.kind === 'invalid') {
    lines.push('', ...wrapText(INVALID_ALLOWLIST_NOTE, getWrapWidth()));
  }
  lines.push('');

  return lines.join('\n');
}

/** The `CodeMie URL:` line (only when configured) and the `Project:` line (project scope only), shown below `Using profile:`. */
export function buildAnalyticsDetailLines(options: Pick<AnalyticsConfirmationOptions, 'codeMieUrl' | 'projectName'>): string[] {
  return [
    ...(options.codeMieUrl ? [chalk.cyan(`CodeMie URL: ${options.codeMieUrl}`)] : []),
    ...(options.projectName ? [chalk.cyan(`Project: ${options.projectName}`)] : []),
  ];
}

/** Width available to the body text: the terminal width (80 when unknown). */
function getWrapWidth(): number {
  return Math.max(20, process.stdout.columns || 80);
}

/** Greedy word wrap; a word longer than the width stays on its own line rather than being split. */
function wrapText(text: string, width: number): string[] {
  const wrapped: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + 1 + word.length > width) {
      wrapped.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) {
    wrapped.push(current);
  }
  return wrapped;
}
