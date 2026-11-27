/**
 * `codemie proxy analytics consent grant|revoke|list` (and the deprecated `connect-folder` /
 * `disconnect-folder`): work-project consent folders, Claude Code only, tied to the signed-in account and backend.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigurationError } from '@/utils/errors.js';
import { resolveProjectRoot } from '@/utils/project-root.js';
import { renderHint } from '@/utils/hint.js';
import { canonicalizePath } from '@/agents/core/project-allowlist.js';
import { currentEvidenceIdentity } from '@/agents/core/evidence/hook-identity.js';
import {
  connectAllFolders,
  connectFolder,
  consentStorePath,
  coveringEntries,
  disconnectAllFolders,
  disconnectFolder,
  listConsents,
} from '@/agents/core/evidence/consent-store.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { resolveConsentProject } from './consent-project.js';
import { DEPRECATION_REMOVE_ON, deprecatedCommand } from '../../deprecation.js';
import {
  RESEND_COMMAND,
  reportEffectiveState,
  resolveAnalyticsConnector,
  withConnectorOptions,
  withErrorHandling,
  type ConnectorOptions,
} from './analytics-targets.js';
import type { DoctorRemedies } from './doctor/plan.js';
import { resolveCollection } from '../shared/analytics-collection/resolve.js';

/** The folder-management actions apply to Claude Code only; the Copilot connectors have no work consent. */
export function assertClaudeOnly(opts: ConnectorOptions): void {
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

type GrantOptions = ConnectorOptions & { project?: string; yes?: boolean; all?: boolean };

/** The confirmation every grant needs unless `--yes`; false when the user declined (nothing changed). */
async function confirmGrant(opts: { yes?: boolean }, message: string, refusal: string): Promise<boolean> {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) throw new ConfigurationError(refusal);
  const { ok } = await inquirer.prompt<{ ok: boolean }>([{ type: 'confirm', name: 'ok', message, default: false }]);
  if (!ok) console.log(chalk.dim('Nothing changed.'));
  return ok;
}

async function connectAllWorkFolders(path: string | undefined, opts: GrantOptions, remedies: DoctorRemedies): Promise<void> {
  await withErrorHandling(async () => {
    assertClaudeOnly(opts);
    if (path !== undefined || opts.project !== undefined) {
      throw new ConfigurationError('--all authorizes every repository: do not combine it with a path or --project.');
    }
    const identity = await requireIdentity();
    console.log('Scope:   any repository');
    console.log(chalk.yellow('Conversation content (prompts, tool input and output, transcripts) of Claude Code sessions in any repository that are billed to a personal subscription becomes visible to the admins of the CodeMie project of each session.'));
    if (!(await confirmGrant(opts, 'Authorize every repository?', 'Confirmation required: re-run with --yes to authorize every repository.'))) return;
    await connectAllFolders(identity);
    console.log(chalk.green('✓ Authorized every repository. Applies to sessions that start after this.'));
    console.log(chalk.dim(`Sessions already held for lack of consent: ${RESEND_COMMAND}`));
    console.log(chalk.dim('Authorizing does not turn collection on and does not change what is collected; it only authorizes sending analytics from personal Claude subscriptions.'));
    await reportEffectiveState(CLAUDE_CODE_OTLP_AGENT_NAME, resolveProjectRoot(), remedies);
  });
}

async function connectWorkFolder(path: string | undefined, opts: GrantOptions): Promise<void> {
  const { remedies } = (await resolveCollection()).doctor;
  if (opts.all) return connectAllWorkFolders(path, opts, remedies);
  await withErrorHandling(async () => {
    assertClaudeOnly(opts);
    const target = path ?? resolveProjectRoot();
    const canonical = await canonicalizePath(target);
    const project = await resolveConsentProject(canonical, opts.project);
    const identity = await requireIdentity();
    console.log(`Folder:  ${canonical}`);
    console.log(`Project: ${project}`);
    console.log('This covers every sub-folder of that folder that resolves to the same project.');
    console.log(chalk.yellow('Conversation content (prompts, tool input and output, transcripts) of those sessions becomes visible to the project admins.'));
    if (!(await confirmGrant(opts, 'Connect this folder?', 'Confirmation required: re-run with --yes to connect this folder.'))) return;
    const saved = await connectFolder({ ...identity, project }, canonical);
    console.log(chalk.green(`✓ Connected ${saved} to project ${project}. Applies to sessions that start after this.`));
    console.log(chalk.dim(`Sessions already held for lack of consent: ${RESEND_COMMAND}`));
    console.log(chalk.dim('Connecting does not turn collection on and does not change what is collected; it only authorizes this folder.'));
    await reportEffectiveState(CLAUDE_CODE_OTLP_AGENT_NAME, saved, remedies);
  });
}

async function disconnectAllWorkFolders(path: string | undefined, opts: ConnectorOptions): Promise<void> {
  await withErrorHandling(async () => {
    assertClaudeOnly(opts);
    if (path !== undefined) {
      throw new ConfigurationError('--all withdraws the all-repositories authorization: do not combine it with a path.');
    }
    const removed = await disconnectAllFolders(await requireIdentity());
    if (removed > 0) {
      console.log(chalk.green('✓ Withdrew the all-repositories authorization. Sessions that rely on it stop publishing, including queued data.'));
      console.log(chalk.dim('Authorizations for individual folders were not touched.'));
    } else {
      console.log(chalk.dim('Nothing to change: there is no all-repositories authorization.'));
    }
  });
}

async function disconnectWorkFolder(path: string | undefined, opts: ConnectorOptions & { all?: boolean }): Promise<void> {
  if (opts.all) return disconnectAllWorkFolders(path, opts);
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
          renderHint(
            e.all_folders
              ? {
                  reason: removed > 0
                    ? `${canonical} is still covered by the all-repositories authorization: new sessions there keep publishing, sessions already running there stop`
                    : `${canonical} is still covered by the all-repositories authorization (any repository)`,
                  command: 'codemie proxy analytics consent revoke --all'
                }
              : {
                  reason: `${canonical} is still covered by the connection ${e.folder} (project ${e.project})`,
                  command: `codemie proxy analytics consent revoke "${e.folder}"`
                }
          )
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
      console.log(e.all_folders ? `${ALL_FOLDERS_LABEL}  ${e.api_identity}${since}` : `${e.folder}  project ${e.project}  ${e.api_identity}${since}`);
    }
  });
}

const ALL_FOLDERS_LABEL = 'any repository';

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
  )
    .option('--all', 'Authorize work-project analytics in any repository instead of one path')
    .action((path: string | undefined, opts: GrantOptions) => connectWorkFolder(path, opts));
  withConnectorOptions(
    consent.command('revoke [path]').description('Withdraw work-project authorization for a folder (default: the current project root)')
  )
    .option('--all', 'Withdraw the all-repositories authorization (per-path authorizations are not touched)')
    .action((path: string | undefined, opts: ConnectorOptions & { all?: boolean }) => disconnectWorkFolder(path, opts));
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
