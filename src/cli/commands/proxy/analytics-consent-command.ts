/**
 * `codemie proxy analytics consent grant|revoke|list` (and the deprecated `connect-folder` /
 * `disconnect-folder`): work-project consent folders, Claude Code only, tied to the signed-in account and backend.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigurationError } from '@/utils/errors.js';
import { rawProjectHeader } from '@/utils/header-value.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import { renderHint } from '@/utils/hint.js';
import { canonicalizePath } from '@/agents/core/project-allowlist.js';
import { currentEvidenceIdentity } from '@/agents/core/evidence/hook-identity.js';
import {
  connectFolder,
  consentStorePath,
  coveringEntries,
  disconnectFolder,
  listConsents,
} from '@/agents/core/evidence/consent-store.js';
import { resolveSessionProject } from '@/agents/core/event-fields/identity-fields.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { DEPRECATION_REMOVE_ON, deprecatedCommand } from '../../deprecation.js';
import {
  reportEffectiveState,
  resolveAnalyticsConnector,
  withConnectorOptions,
  withErrorHandling,
  type ConnectorOptions,
} from './analytics-targets.js';

/** The folder-management actions apply to Claude Code only; the Copilot connectors have no work consent. */
function assertClaudeOnly(opts: ConnectorOptions): void {
  if (resolveAnalyticsConnector(opts) !== CLAUDE_CODE_OTLP_AGENT_NAME) {
    throw new ConfigurationError('Work-consent folders are only available for Claude Code analytics.');
  }
}

export async function requireIdentity(): Promise<{ api_identity: string; owner_hash: string }> {
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
    if (rawProjectHeader(project) === undefined) {
      throw new ConfigurationError(`Project "${project}" cannot be used for a connected work folder: its name has characters the analytics protocol cannot send (only Latin-1 text is supported). Use a project with a supported name.`);
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
    const identity = await requireIdentity();
    const removed = await disconnectFolder(identity, canonical);
    const covering = await coveringEntries(identity, canonical);
    if (removed > 0) {
      console.log(chalk.green(`✓ Disconnected ${canonical}. Sessions that rely on it stop publishing, including queued data.`));
    } else if (covering.length === 0) {
      console.log(chalk.dim(`Nothing to change: ${canonical} is not connected.`));
    }
    // A connected parent still authorizes this folder: say so, with the exact command that withdraws it.
    for (const e of covering) {
      console.log(
        chalk.yellow(
          renderHint({
            reason: `${canonical} is still covered by the connection ${e.folder} (project ${e.project})`,
            command: `codemie proxy analytics consent revoke "${e.folder}"`
          })
        )
      );
    }
  });
}

async function listWorkConsents(): Promise<void> {
  await withErrorHandling(async () => {
    const listed = await listConsents(await requireIdentity());
    if (listed.kind !== 'ok') {
      throw new ConfigurationError(`The work-consent store cannot be read: ${consentStorePath()}. Fix or delete it, then retry.`);
    }
    const entries = listed.entries;
    if (entries.length === 0) {
      console.log(chalk.dim('No work-consent folders are connected.'));
      return;
    }
    for (const e of entries) {
      const since = typeof e.connected_at === 'number' ? ` (since ${new Date(e.connected_at).toISOString().slice(0, 10)})` : '';
      console.log(`${e.folder}  project ${e.project}  ${e.api_identity}${since}`);
    }
  });
}

const CONNECT_FOLDER_DEPRECATION = {
  kind: 'deprecated',
  old: 'codemie proxy analytics connect-folder',
  replacement: 'codemie proxy analytics consent grant',
  removeOn: DEPRECATION_REMOVE_ON
} as const;
const DISCONNECT_FOLDER_DEPRECATION = {
  kind: 'deprecated',
  old: 'codemie proxy analytics disconnect-folder',
  replacement: 'codemie proxy analytics consent revoke',
  removeOn: DEPRECATION_REMOVE_ON
} as const;

function addGrantOptions(command: Command): Command {
  return withConnectorOptions(command)
    .option('--project <name>', 'CodeMie project (default: the one the profile or workspace resolves)')
    .option('--yes', 'Skip the confirmation prompt');
}

/** Adds `consent grant|revoke|list` and the hidden deprecated folder aliases to `proxy analytics`. */
export function addConsentCommands(analytics: Command): void {
  const consent = new Command('consent').description('Manage work-project consent folders (Claude Code only)');
  addGrantOptions(
    consent.command('grant [path]').description('Authorize work-project analytics for a folder (default: the current project root); Claude Code only')
  ).action((path: string | undefined, opts: ConnectorOptions & { project?: string; yes?: boolean }) => connectWorkFolder(path, opts));
  withConnectorOptions(
    consent.command('revoke [path]').description('Withdraw work-project authorization for a folder (default: the current project root)')
  ).action((path: string | undefined, opts: ConnectorOptions) => disconnectWorkFolder(path, opts));
  consent.command('list').description('List the folders authorized for work-project analytics under the signed-in account').action(() => listWorkConsents());
  analytics.addCommand(consent);

  analytics.addCommand(
    addGrantOptions(deprecatedCommand(CONNECT_FOLDER_DEPRECATION, 'connect-folder').argument('[path]')).action(
      (path: string | undefined, opts: ConnectorOptions & { project?: string; yes?: boolean }) => connectWorkFolder(path, opts)
    )
  );
  analytics.addCommand(
    withConnectorOptions(deprecatedCommand(DISCONNECT_FOLDER_DEPRECATION, 'disconnect-folder').argument('[path]')).action(
      (path: string | undefined, opts: ConnectorOptions) => disconnectWorkFolder(path, opts)
    )
  );
}
