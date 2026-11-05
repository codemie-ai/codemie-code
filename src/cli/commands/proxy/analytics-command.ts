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
import { evaluateClaudeAnalyticsGate } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.gate.js';
import { evaluateCopilotAnalyticsGate } from '@/agents/core/copilot-analytics-gate.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import inquirer from 'inquirer';
import { currentEvidenceIdentity } from '@/agents/core/evidence/hook-identity.js';
import { connectFolder, disconnectFolder } from '@/agents/core/evidence/consent-store.js';
import { resolveSessionProject } from '@/agents/core/event-fields/identity-fields.js';
import { adviceForReason, coverageNote, resumeNote } from './analytics-hints.js';
import { hasClaudeCodeOtlpHooks } from './connectors/claude-code-otlp.js';
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

/**
 * Says whether `target` is collected right now and, if not, why and which command changes that.
 * `include`/`enable` only edit the opt-out layer; whether a project is collected at all also depends
 * on the connector scope written by `connect`, so this closes the gap between the two. Advisory
 * only: it reads state, never throws, and never changes the command's outcome.
 */
async function reportEffectiveState(connectorId: AnalyticsConnectorId, target: string): Promise<void> {
  try {
    const decision =
      connectorId === CLAUDE_CODE_OTLP_AGENT_NAME
        ? await evaluateClaudeAnalyticsGate(target)
        : await evaluateCopilotAnalyticsGate(connectorId, target);
    // The Claude gate only models opt-outs; with no CodeMie hooks in settings.json nothing runs at all.
    const hooksMissing = decision.tracked && connectorId === CLAUDE_CODE_OTLP_AGENT_NAME && !(await hasClaudeCodeOtlpHooks());
    if (decision.tracked && !hooksMissing) {
      console.log(chalk.dim(`Effective now: ${target} is tracked.`));
      return;
    }
    const reason = hooksMissing ? 'hooks-not-installed' : 'reason' in decision ? decision.reason : 'unknown';
    const advice = adviceForReason(connectorId, reason, target);
    console.log(chalk.yellow(`Note: ${target} is NOT tracked${advice ? ` — ${advice.description}` : ` (${reason})`}.`));
    if (advice?.nextStep) {
      console.log(chalk.yellow(`  Next step: ${advice.nextStep}`));
    }
  } catch (error) {
    logger.debug(
      '[proxy analytics] could not compute the effective state',
      ...sanitizeLogArgs({ err: error instanceof Error ? error.message : String(error) })
    );
  }
}

async function setEnabled(enabled: boolean, opts: ConnectorOptions): Promise<void> {
  await withErrorHandling(async () => {
    const connectorId = resolveAnalyticsConnector(opts);
    const store = storeForConnector(connectorId);
    let changed = true;
    await store.update((current) => {
      changed = current.enabled !== enabled;
      return { ...current, enabled };
    });
    if (!changed) {
      console.log(chalk.dim('Nothing to change.'));
    } else {
      printSaved(store);
    }
    if (!enabled) {
      console.log(chalk.dim(coverageNote(connectorId)));
      return;
    }
    const resume = changed ? resumeNote(connectorId) : undefined;
    if (resume) {
      console.log(chalk.dim(resume));
    }
    await reportEffectiveState(connectorId, process.cwd());
  });
}

async function excludeProject(path: string | undefined, opts: ConnectorOptions): Promise<void> {
  await withErrorHandling(async () => {
    const connectorId = resolveAnalyticsConnector(opts);
    const store = storeForConnector(connectorId);
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
    console.log(chalk.dim(coverageNote(connectorId)));
  });
}

async function includeProject(path: string | undefined, opts: ConnectorOptions): Promise<void> {
  await withErrorHandling(async () => {
    const connectorId = resolveAnalyticsConnector(opts);
    const store = storeForConnector(connectorId);
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
    } else {
      printSaved(store, ` (project: ${canonical})`);
      const resume = resumeNote(connectorId);
      if (resume) {
        console.log(chalk.dim(resume));
      }
    }
    await reportEffectiveState(connectorId, canonical);
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

/** The folder-management actions apply to Claude Code only; the Copilot connectors have no work consent. */
function assertClaudeOnly(opts: ConnectorOptions): void {
  if (resolveAnalyticsConnector(opts) !== CLAUDE_CODE_OTLP_AGENT_NAME) {
    throw new ConfigurationError('Work-consent folders are only available for Claude Code analytics.');
  }
}

async function requireIdentity(): Promise<{ api_identity: string; owner_hash: string }> {
  const identity = await currentEvidenceIdentity();
  if (!identity) {
    throw new ConfigurationError('Sign in to CodeMie first (codemie profile login): the consent is tied to your account and backend.');
  }
  return identity;
}

async function connectWorkFolder(path: string | undefined, opts: ConnectorOptions & { project?: string; yes?: boolean }): Promise<void> {
  await withErrorHandling(async () => {
    assertClaudeOnly(opts);
    const target = path ?? resolveProjectRoot();
    const canonical = await canonicalizePath(target);
    // The project may come from the profile or workspace configuration; that only proposes it, never grants consent.
    const project = (opts.project ?? (await resolveSessionProject(canonical, undefined))).trim();
    if (!project) {
      throw new ConfigurationError('No CodeMie project resolved for this folder. Pass --project <name>.');
    }
    const identity = await requireIdentity();
    console.log(`Folder:  ${canonical}`);
    console.log(`Project: ${project}`);
    console.log('This covers every sub-folder of that folder that resolves to the same project.');
    console.log(chalk.yellow('Conversation content (prompts, tool input and output, transcripts) of those sessions becomes visible to the project admins.'));
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        throw new ConfigurationError('Confirmation required: re-run with --yes to connect this folder.');
      }
      const { ok } = await inquirer.prompt<{ ok: boolean }>([{ type: 'confirm', name: 'ok', message: 'Connect this folder?', default: false }]);
      if (!ok) {
        console.log(chalk.dim('Nothing changed.'));
        return;
      }
    }
    const saved = await connectFolder({ ...identity, project }, canonical);
    console.log(chalk.green(`✓ Connected ${saved} to project ${project}. Applies to sessions that start after this.`));
    console.log(chalk.dim('Connecting does not turn collection on and does not change what is collected; it only authorizes this folder.'));
    await reportEffectiveState(CLAUDE_CODE_OTLP_AGENT_NAME, saved);
  });
}

async function disconnectWorkFolder(path: string | undefined, opts: ConnectorOptions): Promise<void> {
  await withErrorHandling(async () => {
    assertClaudeOnly(opts);
    const canonical = await canonicalizePath(path ?? resolveProjectRoot());
    const removed = await disconnectFolder(await requireIdentity(), canonical);
    console.log(
      removed > 0
        ? chalk.green(`✓ Disconnected ${canonical}. Sessions that rely on it stop publishing, including queued data.`)
        : chalk.dim(`Nothing to change: ${canonical} is not connected.`)
    );
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
    analytics
      .command('connect-folder [path]')
      .description('Authorize work-project analytics for a folder (default: the current project root); Claude Code only')
  )
    .option('--project <name>', 'CodeMie project (default: the one the profile or workspace resolves)')
    .option('--yes', 'Skip the confirmation prompt')
    .action((path: string | undefined, opts: ConnectorOptions & { project?: string; yes?: boolean }) => connectWorkFolder(path, opts));

  withConnectorOptions(
    analytics.command('disconnect-folder [path]').description('Withdraw work-project authorization for a folder (default: the current project root)')
  ).action((path: string | undefined, opts: ConnectorOptions) => disconnectWorkFolder(path, opts));

  withConnectorOptions(
    analytics.command('status').description('Show the effective analytics configuration for the connector')
  )
    .option('--json', 'Emit status as JSON instead of formatted output')
    .action((opts: ConnectorOptions & { json?: boolean }) => showStatus(opts));

  return analytics;
}
