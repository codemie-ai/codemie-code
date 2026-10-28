/**
 * `codemie proxy analytics` — turns Claude Code analytics collection off/on or excludes a single
 * project, without uninstalling the hooks `connect --claude-code-otlp` already wrote. Deliberately
 * nested under `proxy`, not a new top-level command, so it is never confused with the unrelated
 * reporting command at `codemie analytics` (`src/cli/commands/analytics/`).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigurationError } from '@/utils/errors.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import { addProjectPath, canonicalizePath, isPathInside, removeProjectPath } from '@/agents/core/project-allowlist.js';
import {
  getClaudeAnalyticsPreferencesPath,
  updateClaudeAnalyticsPreferences,
  type ClaudeAnalyticsPreferences,
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js';
import { collectClaudeAnalyticsStatus, formatClaudeAnalyticsStatus } from './analytics-status.js';

async function withErrorHandling(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof ConfigurationError ? error.message : String(error);
    console.error(chalk.red(`✗ ${message}`));
    process.exitCode = 1;
  }
}

function printSaved(suffix = ''): void {
  console.log(chalk.green(`✓ Saved to ${getClaudeAnalyticsPreferencesPath()}. Applies to the next Claude Code hook event.${suffix}`));
}

async function setEnabled(enabled: boolean): Promise<void> {
  await withErrorHandling(async () => {
    let changed = true;
    await updateClaudeAnalyticsPreferences((current) => {
      changed = current.enabled !== enabled;
      return { ...current, enabled };
    });
    if (!changed) {
      console.log(chalk.dim('Nothing to change.'));
      return;
    }
    printSaved();
  });
}

async function excludeProject(path: string | undefined): Promise<void> {
  await withErrorHandling(async () => {
    const target = path ?? resolveProjectRoot();
    const canonical = await canonicalizePath(target);
    let changed = true;
    await updateClaudeAnalyticsPreferences(async (current: ClaudeAnalyticsPreferences) => {
      const excludedProjects = await addProjectPath(current.excludedProjects, target);
      changed = excludedProjects.length !== current.excludedProjects.length;
      return changed ? { ...current, excludedProjects } : current;
    });
    if (!changed) {
      console.log(chalk.dim('Nothing to change.'));
      return;
    }
    printSaved(` (project: ${canonical})`);
  });
}

async function includeProject(path: string | undefined): Promise<void> {
  await withErrorHandling(async () => {
    const target = path ?? resolveProjectRoot();
    const canonical = await canonicalizePath(target);
    let changed = true;
    let coveringParent: string | undefined;
    await updateClaudeAnalyticsPreferences(async (current: ClaudeAnalyticsPreferences) => {
      const excludedProjects = await removeProjectPath(current.excludedProjects, target);
      changed = excludedProjects.length !== current.excludedProjects.length;
      if (!changed) {
        for (const entry of current.excludedProjects) {
          if (isPathInside(canonical, await canonicalizePath(entry))) {
            coveringParent = entry;
            break;
          }
        }
      }
      return changed ? { ...current, excludedProjects } : current;
    });
    if (!changed) {
      console.log(
        chalk.dim(
          coveringParent
            ? `Nothing to change: ${canonical} is still excluded via ${coveringParent}.`
            : 'Nothing to change.'
        )
      );
      return;
    }
    printSaved(` (project: ${canonical})`);
  });
}

export function createProxyAnalyticsCommand(): Command {
  const analytics = new Command('analytics');
  analytics.description('Turn Claude Code analytics collection off/on, or exclude a single project');

  analytics
    .command('disable')
    .description('Stop all Claude Code analytics collection (hooks stay installed)')
    .action(() => setEnabled(false));

  analytics
    .command('enable')
    .description('Resume Claude Code analytics collection')
    .action(() => setEnabled(true));

  analytics
    .command('exclude [path]')
    .description('Exclude one project from analytics collection (default: the current project root)')
    .action((path?: string) => excludeProject(path));

  analytics
    .command('include [path]')
    .description('Remove a project from the exclusion list (default: the current project root)')
    .action((path?: string) => includeProject(path));

  analytics
    .command('status')
    .description('Show the effective Claude Code analytics configuration')
    .option('--json', 'Emit status as JSON instead of formatted output')
    .action(async (opts: { json?: boolean }) => {
      const status = await collectClaudeAnalyticsStatus(process.cwd());
      console.log(opts.json ? JSON.stringify(status, null, 2) : formatClaudeAnalyticsStatus(status));
    });

  return analytics;
}
