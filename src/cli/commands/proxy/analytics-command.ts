/**
 * `codemie proxy analytics` — turns analytics collection off/on or excludes a single project for
 * one OTLP connector (Claude Code by default; Copilot CLI / Copilot Chat via a connector flag),
 * without uninstalling the hooks `connect` already wrote. Deliberately nested under `proxy`, not
 * a new top-level command, so it is never confused with the unrelated reporting command at
 * `codemie analytics` (`src/cli/commands/analytics/`).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigurationError } from '@/utils/errors.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import {
  addProjectPath,
  canonicalizePath,
  comparable,
  isPathInside,
  removeProjectPath,
} from '@/agents/core/project-allowlist.js';
import {
  getClaudeAnalyticsPreferencesPath,
  updateClaudeAnalyticsPreferences,
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js';
import {
  getCopilotAnalyticsPreferencesPath,
  updateCopilotAnalyticsPreferences,
} from '@/agents/core/copilot-analytics-preferences.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import {
  collectClaudeAnalyticsStatus,
  collectCopilotAnalyticsStatus,
  formatClaudeAnalyticsStatus,
  formatCopilotAnalyticsStatus,
} from './analytics-status.js';

type AnalyticsConnectorId =
  | typeof CLAUDE_CODE_OTLP_AGENT_NAME
  | typeof COPILOT_CLI_OTLP_AGENT_NAME
  | typeof COPILOT_CHAT_OTLP_AGENT_NAME;

interface ConnectorOptions {
  claudeCodeOtlp?: boolean;
  copilotCliOtlp?: boolean;
  copilotChatOtlp?: boolean;
}

interface AnalyticsPrefs {
  enabled: boolean;
  excludedProjects: string[];
}

interface AnalyticsStore {
  /** Human label used in the success message, e.g. "Claude Code". */
  label: string;
  path(): string;
  update(mutate: (current: AnalyticsPrefs) => AnalyticsPrefs | Promise<AnalyticsPrefs>): Promise<void>;
}

/** Picks the connector from the flags; none means Claude Code (the pre-existing behavior). */
export function resolveAnalyticsConnector(opts: ConnectorOptions): AnalyticsConnectorId {
  const selected: AnalyticsConnectorId[] = [];
  if (opts.claudeCodeOtlp) selected.push(CLAUDE_CODE_OTLP_AGENT_NAME);
  if (opts.copilotCliOtlp) selected.push(COPILOT_CLI_OTLP_AGENT_NAME);
  if (opts.copilotChatOtlp) selected.push(COPILOT_CHAT_OTLP_AGENT_NAME);
  if (selected.length > 1) {
    throw new ConfigurationError(
      `Choose one connector at a time; got: ${selected.map((s) => `--${s}`).join(', ')}.`
    );
  }
  return selected[0] ?? CLAUDE_CODE_OTLP_AGENT_NAME;
}

function storeForConnector(connectorId: AnalyticsConnectorId): AnalyticsStore {
  if (connectorId === CLAUDE_CODE_OTLP_AGENT_NAME) {
    return {
      label: 'Claude Code',
      path: getClaudeAnalyticsPreferencesPath,
      async update(mutate) {
        await updateClaudeAnalyticsPreferences(async (current) => ({ ...current, ...(await mutate(current)) }));
      },
    };
  }
  return {
    label: connectorId === COPILOT_CLI_OTLP_AGENT_NAME ? 'Copilot CLI' : 'Copilot Chat',
    path: getCopilotAnalyticsPreferencesPath,
    async update(mutate) {
      await updateCopilotAnalyticsPreferences(connectorId, mutate);
    },
  };
}

async function withErrorHandling(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof ConfigurationError ? error.message : String(error);
    console.error(chalk.red(`✗ ${message}`));
    process.exitCode = 1;
  }
}

function printSaved(store: AnalyticsStore, suffix = ''): void {
  console.log(chalk.green(`✓ Saved to ${store.path()}. Applies to the next ${store.label} hook event.${suffix}`));
}

async function setEnabled(enabled: boolean, opts: ConnectorOptions): Promise<void> {
  await withErrorHandling(async () => {
    const store = storeForConnector(resolveAnalyticsConnector(opts));
    let changed = true;
    await store.update((current) => {
      changed = current.enabled !== enabled;
      return { ...current, enabled };
    });
    if (!changed) {
      console.log(chalk.dim('Nothing to change.'));
      return;
    }
    printSaved(store);
  });
}

async function excludeProject(path: string | undefined, opts: ConnectorOptions): Promise<void> {
  await withErrorHandling(async () => {
    const store = storeForConnector(resolveAnalyticsConnector(opts));
    const target = path ?? resolveProjectRoot();
    const canonical = await canonicalizePath(target);
    let changed = true;
    let coveredBy: string | undefined;
    await store.update(async (current) => {
      for (const entry of current.excludedProjects) {
        const canonicalEntry = await canonicalizePath(entry);
        if (comparable(canonicalEntry) !== comparable(canonical) && isPathInside(canonical, canonicalEntry)) {
          coveredBy = entry;
          break;
        }
      }
      if (coveredBy) {
        changed = false;
        return current;
      }
      // Drop entries strictly nested under the new, broader exclusion — they are now redundant.
      // The entry equal to the new target itself is kept so `addProjectPath` can dedupe it.
      const kept: string[] = [];
      for (const entry of current.excludedProjects) {
        const canonicalEntry = await canonicalizePath(entry);
        const isRedundantChild = comparable(canonicalEntry) !== comparable(canonical) && isPathInside(canonicalEntry, canonical);
        if (!isRedundantChild) {
          kept.push(entry);
        }
      }
      const excludedProjects = await addProjectPath(kept, target);
      changed = excludedProjects.length !== current.excludedProjects.length || kept.length !== current.excludedProjects.length;
      return changed ? { ...current, excludedProjects } : current;
    });
    if (!changed) {
      console.log(
        chalk.dim(
          coveredBy ? `Nothing to change: ${canonical} is already excluded via ${coveredBy}.` : 'Nothing to change.'
        )
      );
      return;
    }
    printSaved(store, ` (project: ${canonical})`);
  });
}

async function includeProject(path: string | undefined, opts: ConnectorOptions): Promise<void> {
  await withErrorHandling(async () => {
    const store = storeForConnector(resolveAnalyticsConnector(opts));
    const target = path ?? resolveProjectRoot();
    const canonical = await canonicalizePath(target);
    let removed = true;
    let coveringParent: string | undefined;
    await store.update(async (current) => {
      const excludedProjects = await removeProjectPath(current.excludedProjects, target);
      removed = excludedProjects.length !== current.excludedProjects.length;
      // Checked against the list AFTER removal: a redundant entry nested under a
      // still-present parent must not be reported as "resumed" (CR-003 follow-up).
      for (const entry of excludedProjects) {
        if (isPathInside(canonical, await canonicalizePath(entry))) {
          coveringParent = entry;
          break;
        }
      }
      return removed ? { ...current, excludedProjects } : current;
    });
    if (coveringParent) {
      console.log(chalk.dim(`Nothing to change: ${canonical} is still excluded via ${coveringParent}.`));
      return;
    }
    if (!removed) {
      console.log(chalk.dim('Nothing to change.'));
      return;
    }
    printSaved(store, ` (project: ${canonical})`);
  });
}

async function showStatus(opts: ConnectorOptions & { json?: boolean }): Promise<void> {
  await withErrorHandling(async () => {
    const connectorId = resolveAnalyticsConnector(opts);
    if (connectorId === CLAUDE_CODE_OTLP_AGENT_NAME) {
      const status = await collectClaudeAnalyticsStatus(process.cwd());
      console.log(opts.json ? JSON.stringify(status, null, 2) : formatClaudeAnalyticsStatus(status));
      return;
    }
    const status = await collectCopilotAnalyticsStatus(connectorId, process.cwd());
    console.log(opts.json ? JSON.stringify(status, null, 2) : formatCopilotAnalyticsStatus(status));
  });
}

function withConnectorOptions(command: Command): Command {
  return command
    .option(`--${CLAUDE_CODE_OTLP_AGENT_NAME}`, 'Target Claude Code (default)')
    .option(`--${COPILOT_CLI_OTLP_AGENT_NAME}`, 'Target Copilot CLI')
    .option(`--${COPILOT_CHAT_OTLP_AGENT_NAME}`, 'Target Copilot Chat (VS Code)');
}

export function createProxyAnalyticsCommand(): Command {
  const analytics = new Command('analytics');
  analytics.description(
    'Turn analytics collection off/on, or exclude a single project (Claude Code by default; pass a connector flag for Copilot)'
  );

  withConnectorOptions(
    analytics.command('disable').description('Stop all analytics collection for the connector (hooks stay installed)')
  ).action((opts: ConnectorOptions) => setEnabled(false, opts));

  withConnectorOptions(analytics.command('enable').description('Resume analytics collection for the connector')).action(
    (opts: ConnectorOptions) => setEnabled(true, opts)
  );

  withConnectorOptions(
    analytics
      .command('exclude [path]')
      .description('Exclude one project from analytics collection (default: the current project root)')
  ).action((path: string | undefined, opts: ConnectorOptions) => excludeProject(path, opts));

  withConnectorOptions(
    analytics
      .command('include [path]')
      .description('Remove a project from the exclusion list (default: the current project root)')
  ).action((path: string | undefined, opts: ConnectorOptions) => includeProject(path, opts));

  withConnectorOptions(
    analytics.command('status').description('Show the effective analytics configuration for the connector')
  )
    .option('--json', 'Emit status as JSON instead of formatted output')
    .action((opts: ConnectorOptions & { json?: boolean }) => showStatus(opts));

  return analytics;
}
