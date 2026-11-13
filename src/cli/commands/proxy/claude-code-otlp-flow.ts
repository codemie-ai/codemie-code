/**
 * Claude Code analytics (`--claude-code-otlp`) steps of `codemie proxy connect`:
 * the consent gate that runs before anything is started or written, and the
 * settings writer that runs once the shared daemon is up. Kept apart from
 * `connect-orchestrator.ts`, which owns the multi-target daemon lifecycle.
 */
import chalk from 'chalk';
import { ConfigurationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { writeClaudeCodeOtlpConfig } from './connectors/claude-code-otlp.js';
import type { AllowlistScope } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import {
  canonicalizePath,
  readAllowlistState,
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import { promptAnalyticsConfirmation } from './prompts/analytics-confirmation.js';
import type { TargetResult } from './connect-orchestrator.js';

/** Profile and CodeMie URL shown to the user, resolved once by the caller. */
export interface ClaudeCodeOtlpDisplay {
  profile: string;
  codeMieUrl?: string;
}

/** Inputs for {@link runClaudeCodeOtlp}. */
export interface ClaudeCodeOtlpRunOptions extends ClaudeCodeOtlpDisplay {
  force?: boolean;
  scope?: AllowlistScope;
}

/**
 * Write the Claude Code analytics settings and print the resulting configuration.
 * Failures are reported in the returned result rather than thrown, so one failing
 * target does not stop the others.
 */
export async function runClaudeCodeOtlp(options: ClaudeCodeOtlpRunOptions): Promise<TargetResult> {
  const label = 'Claude Code Analytics';
  try {
    await writeClaudeCodeOtlpConfig({ force: options.force, scope: options.scope });
    console.log(chalk.green(`✓ Claude Code Analytics configured successfully`));
    console.log(chalk.bold('\nAnalytics Configuration:'));
    const rows = [
      ['Using profile', options.profile],
      ...(options.codeMieUrl ? [['CodeMie URL', options.codeMieUrl]] : []),
      ['Scope', options.scope ?? 'user'],
    ];
    const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 1;
    console.log(rows.map(([label, value]) =>
      `${chalk.cyan(label.padEnd(labelWidth) + '│ ')}${chalk.white(value)}`
    ).join('\n'));
    console.log(chalk.yellow('  First-time setup needs a Claude Code restart; allowlist changes apply immediately.'));
    return { label, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[proxy] Failed to configure Claude Code analytics', ...sanitizeLogArgs({ error: message }));
    console.log(chalk.yellow(`  Could not configure Claude Code analytics: ${message}`));
    return { label, ok: false, error: message };
  }
}

/**
 * Guards the Claude Code analytics write. The invalid-allowlist check runs on
 * every path; the prompt is skipped only for `--silent`, which counts as consent.
 * Returns whether the user agreed; a decline must leave the allowlist, settings
 * and any running daemon untouched. `display` feeds the prompt header only.
 */
export async function confirmClaudeCodeOtlp(
  scope: AllowlistScope,
  force: boolean,
  silent: boolean,
  display: ClaudeCodeOtlpDisplay,
): Promise<boolean> {
  const allowlist = await readAllowlistState();
  if (allowlist.kind === 'invalid' && !force) {
    throw new ConfigurationError(
      'Claude Code settings contain an invalid CODEMIE_ANALYTICS_PROJECT_FILTER value. ' +
      'Fix it manually or re-run with --force to discard it.'
    );
  }

  if (silent) {
    return true;
  }

  const confirmation = await promptAnalyticsConfirmation({
    profile: display.profile,
    codeMieUrl: display.codeMieUrl,
    scope,
    allowlist,
    currentProjectPath: await canonicalizePath(resolveProjectRoot()),
  });

  return confirmation === 'enable';
}
