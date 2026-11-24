import chalk from 'chalk';
import inquirer from 'inquirer';
import type { AllowlistScope, AllowlistState } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';

/**
 * `enable` applies the analytics configuration; `enable-with-consent` does too and the user also confirmed the
 * work-consent question; `cancel` covers Decline and a closed prompt.
 */
export type AnalyticsConfirmationResult = 'enable' | 'enable-with-consent' | 'cancel';

/** Inputs that determine the wording of the analytics confirmation prompt. */
export interface AnalyticsConfirmationOptions {
  /** Profile the analytics will be sent through, shown in the header. */
  profile: string;
  /** CodeMie URL of that profile, shown in the header only when configured. */
  codeMieUrl?: string;
  /** Current state of the Claude Code project allowlist; only used to warn when it cannot be read. */
  allowlist: AllowlistState;
  /** Analytics project name of the current project; set only for project scope, where it is shown. */
  repositoryName?: string;
  /**
   * Labels of the Claude clients this run routes through the proxy; a note names them. Nothing is added when empty
   * or absent.
   */
  routedClients?: string[];
  /**
   * When set, a Confirm / Decline question about sending analytics from personal Claude subscriptions comes before the
   * main question; the wording follows the scope. It names no repository or project.
   */
  workConsentQuestion?: { scope: AllowlistScope };
}

const INVALID_ALLOWLIST_NOTE = 'The project list in Claude Code settings cannot be read and will be replaced.';

/**
 * Show the analytics confirmation and wait for the user's decision. The details
 * are printed first, then the same inquirer list used by `codemie setup` asks
 * Confirm / Decline, preceded by the work-consent Confirm / Decline question when `workConsentQuestion` is set.
 * A closed prompt resolves to `cancel` so the caller leaves the allowlist and daemon untouched. Callers must gate
 * on an interactive terminal.
 */
export async function promptAnalyticsConfirmation(
  options: AnalyticsConfirmationOptions,
): Promise<AnalyticsConfirmationResult> {
  console.log(buildAnalyticsConfirmationMessage(options));
  let withConsent = false;
  if (options.workConsentQuestion) {
    const answer = await askConfirm(workConsentQuestionText(options.workConsentQuestion.scope));
    if (answer === undefined) return 'cancel';
    withConsent = answer;
  }
  if (!(await promptConfirmDecline('Enable Claude Code analytics?'))) return 'cancel';
  return withConsent ? 'enable-with-consent' : 'enable';
}

function workConsentQuestionText(scope: AllowlistScope): string {
  return `Send analytics from personal Claude subscriptions in ${scope === 'project' ? 'this repository' : 'any repository'}?`;
}

/** `confirm` drops the project list; `cancel` covers Decline and a closed prompt. */
export type ScopeDropConfirmationResult = 'confirm' | 'cancel';

/** Inputs of {@link promptScopeDropConfirmation}. */
export interface ScopeDropConfirmationOptions {
  /** Connector label, e.g. `Claude Code analytics`. */
  label: string;
  /** The tracked projects a user-scope connect drops. */
  paths: string[];
}

/**
 * Lists the projects a user-scope connect drops from a connector's project list and asks
 * Confirm / Decline with the same inquirer list as {@link promptAnalyticsConfirmation}.
 * A closed prompt resolves to `cancel`. Callers must gate on an interactive terminal.
 */
export async function promptScopeDropConfirmation(
  options: ScopeDropConfirmationOptions,
): Promise<ScopeDropConfirmationResult> {
  console.log([...buildScopeDropLines(options), ''].join('\n'));
  return (await promptConfirmDecline(`Drop the tracked project list of ${options.label}?`)) ? 'confirm' : 'cancel';
}

/** The lines naming the projects a user-scope connect drops (pure; also printed in place of the prompt for `--yes`). */
export function buildScopeDropLines(options: ScopeDropConfirmationOptions): string[] {
  return [
    chalk.yellow(`${options.label} tracks only these projects; connecting in user scope tracks every project and drops the list:`),
    ...options.paths.map((path) => `  - ${path}`),
  ];
}

/** The Confirm / Decline list; a closed prompt (Ctrl+C) counts as Decline. */
async function promptConfirmDecline(message: string): Promise<boolean> {
  return (await askConfirm(message)) === true;
}

/** A Confirm (preselected) / Decline list: the answer, or `undefined` when the prompt was closed (Ctrl+C). */
async function askConfirm(message: string): Promise<boolean | undefined> {
  try {
    const { enable } = await inquirer.prompt<{ enable: boolean }>([
      {
        type: 'list',
        name: 'enable',
        message,
        default: true,
        choices: [
          { name: 'Confirm', value: true },
          { name: 'Decline', value: false },
        ],
      },
    ]);
    return enable;
  } catch (error) {
    if (error instanceof Error && (error.name === 'ExitPromptError' || error.name === 'AbortPromptError')) {
      return undefined;
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
  if (options.routedClients && options.routedClients.length > 0) {
    lines.push('', ...wrapText(routedClientsNote(options.routedClients), getWrapWidth()));
  }
  lines.push('');

  return lines.join('\n');
}

/** `A`, `A and B`, `A, B and C`. */
function joinLabels(labels: string[]): string {
  return labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function routedClientsNote(clients: string[]): string {
  return `${joinLabels(clients)} will be routed through the proxy, not your Claude login.`;
}

/** The `CodeMie URL:` line (only when configured) and the `Repository:` line (project scope only), shown below `Using profile:`. */
export function buildAnalyticsDetailLines(options: Pick<AnalyticsConfirmationOptions, 'codeMieUrl' | 'repositoryName'>): string[] {
  return [
    ...(options.codeMieUrl ? [chalk.cyan(`CodeMie URL: ${options.codeMieUrl}`)] : []),
    ...(options.repositoryName ? [chalk.cyan(`Repository: ${options.repositoryName}`)] : []),
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
