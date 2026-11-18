/**
 * `codemie proxy analytics` — turns analytics collection off/on or excludes a single project for
 * the OTLP connectors (every connected connector by default; one connector via a connector flag),
 * without uninstalling the hooks `connect` already wrote. Deliberately nested under `proxy`, not
 * a new top-level command, so it is never confused with the unrelated reporting command at
 * `codemie analytics` (`src/cli/commands/analytics/`).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigurationError } from '@/utils/errors.js';
import { rawProjectHeader } from '@/utils/header-value.js';
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
  DEFAULT_CLAUDE_ANALYTICS_PREFERENCES,
  readClaudeAnalyticsPreferences,
  updateClaudeAnalyticsPreferences,
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js';
import {
  getCopilotAnalyticsPreferencesPath,
  DEFAULT_COPILOT_ANALYTICS_RECORD,
  readCopilotAnalyticsPreferences,
  updateCopilotAnalyticsPreferences,
} from '@/agents/core/copilot-analytics-preferences.js';
import { evaluateClaudeAnalyticsGate } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.gate.js';
import { evaluateCopilotAnalyticsGate } from '@/agents/core/copilot-analytics-gate.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import inquirer from 'inquirer';
import { currentEvidenceIdentity } from '@/agents/core/evidence/hook-identity.js';
import { connectFolder, coveringEntries, disconnectFolder, listConsents } from '@/agents/core/evidence/consent-store.js';
import { resolveSessionProject } from '@/agents/core/event-fields/identity-fields.js';
import { adviceForReason, coverageNote, resumeNote } from './analytics-hints.js';
import { hasClaudeCodeOtlpHooks } from './connectors/claude-code-otlp.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import {
  ANALYTICS_CONNECTORS,
  hasActiveAnalyticsConnector,
  listActiveAnalyticsConnectors,
  type AnalyticsConnector,
} from './analytics-connectors.js';
import { DEPRECATION_REMOVE_ON, deprecatedCommand } from '../../deprecation.js';
import { printNext } from '../../related-commands.js';
import { readDaemonStatus } from './daemon-manager.js';
import { checkProxyHealth } from './health-check.js';
import { collectDeliveryHealth, type DeliveryHealth } from './delivery-health.js';
import { renderHint } from '@/utils/hint.js';
import { formatReportRows, type ReportRow } from './analytics-report.js';

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
  /** The current preferences, or null when they cannot be read. */
  read(): Promise<AnalyticsPrefs | null>;
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
      async read() {
        const prefs = await readClaudeAnalyticsPreferences();
        return prefs.kind === 'ok' ? prefs.value : null;
      },
      async update(mutate) {
        await updateClaudeAnalyticsPreferences(async (current) => {
          const next = { ...current, ...(await mutate(current)) };
          // Every explicit enable/disable starts a new collection generation, in the same atomic write.
          return next.enabled === current.enabled ? next : { ...next, collectionGeneration: current.collectionGeneration + 1 };
        });
      },
    };
  }
  return {
    label: connectorId === COPILOT_CLI_OTLP_AGENT_NAME ? 'Copilot CLI' : 'Copilot Chat',
    path: getCopilotAnalyticsPreferencesPath,
    async read() {
      const prefs = await readCopilotAnalyticsPreferences(connectorId);
      return prefs.kind === 'ok' ? prefs.value : null;
    },
    async update(mutate) {
      await updateCopilotAnalyticsPreferences(connectorId, mutate);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof ConfigurationError ? error.message : error instanceof Error ? error.message : String(error);
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
 * only: it reads state, never throws, and never changes the command's outcome. With `confirmLabel`
 * a tracked project is confirmed as tracked by that connector.
 */
async function reportEffectiveState(connectorId: AnalyticsConnectorId, target: string, confirmLabel?: string): Promise<void> {
  try {
    const decision =
      connectorId === CLAUDE_CODE_OTLP_AGENT_NAME
        ? await evaluateClaudeAnalyticsGate(target)
        : await evaluateCopilotAnalyticsGate(connectorId, target);
    // The Claude gate only models opt-outs; with no CodeMie hooks in settings.json nothing runs at all.
    const hooksMissing = decision.tracked && connectorId === CLAUDE_CODE_OTLP_AGENT_NAME && !(await hasClaudeCodeOtlpHooks());
    if (decision.tracked && !hooksMissing) {
      console.log(
        confirmLabel
          ? chalk.green(`✓ Done: ${target} is tracked by ${confirmLabel}.`)
          : chalk.dim(`Effective now: ${target} is tracked.`)
      );
      return;
    }
    const reason = hooksMissing ? 'hooks-not-installed' : 'reason' in decision ? decision.reason : 'unknown';
    const advice = adviceForReason(connectorId, reason, target);
    console.log(chalk.yellow(`Note: ${target} is NOT tracked${advice ? ` — ${advice.description}` : ` (${reason})`}.`));
    const nextStep = advice?.command ?? advice?.action;
    if (nextStep) {
      console.log(chalk.yellow(`  ${renderHint({ reason: 'To change this', ...(advice?.command ? { command: advice.command } : { action: advice?.action }) })}`));
    }
  } catch (error) {
    logger.debug(
      '[proxy analytics] could not compute the effective state',
      ...sanitizeLogArgs({ err: error instanceof Error ? error.message : String(error) })
    );
  }
}

type AnalyticsVerb = 'enable' | 'disable' | 'include' | 'exclude';

export interface TargetSelection {
  /** The connectors the command acts on, in table order. */
  targets: AnalyticsConnector[];
  /** Targets whose connector state could not be read; they are still acted on, and named. */
  unreadable: AnalyticsConnector[];
}

function hasConnectorFlag(opts: ConnectorOptions): boolean {
  return Boolean(opts.claudeCodeOtlp || opts.copilotCliOtlp || opts.copilotChatOtlp);
}

const CONNECTOR_FLAGS = [CLAUDE_CODE_OTLP_AGENT_NAME, COPILOT_CLI_OTLP_AGENT_NAME, COPILOT_CHAT_OTLP_AGENT_NAME].map((id) => `--${id}`);

interface ConnectorState {
  active: boolean;
  /** A preferences record is stored for the connector. */
  hasPreference: boolean;
  /** Its activity check throws, its stored scope is invalid, or its preferences cannot be read. */
  unreadable: boolean;
}

/** Reads whether the connector has a stored preferences record and whether that read failed. */
async function readPreferenceState(connectorId: AnalyticsConnectorId): Promise<{ stored: boolean; unreadable: boolean }> {
  const state =
    connectorId === CLAUDE_CODE_OTLP_AGENT_NAME
      ? await readClaudeAnalyticsPreferences()
      : await readCopilotAnalyticsPreferences(connectorId);
  if (state.kind !== 'ok') return { stored: false, unreadable: true };
  // An absent record reads as the shared default constant; a stored one is always a fresh object.
  const absent = state.value === DEFAULT_CLAUDE_ANALYTICS_PREFERENCES || state.value === DEFAULT_COPILOT_ANALYTICS_RECORD;
  return { stored: !absent, unreadable: false };
}

async function connectorState(entry: AnalyticsConnector): Promise<ConnectorState> {
  let active = false;
  let unreadable = false;
  try {
    active = await entry.isActive();
  } catch (error) {
    logger.debug(`[proxy analytics] ${entry.id} activity check failed:`, error);
    unreadable = true;
  }
  if ('invalid' in (await entry.readScope())) {
    unreadable = true;
  }
  const preference = await readPreferenceState(entry.id);
  return { active, hasPreference: preference.stored, unreadable: unreadable || preference.unreadable };
}

/**
 * The connectors a `proxy analytics` write acts on. A connector flag picks exactly that connector.
 * Without one, `include`/`exclude` act on every connected connector, while `enable`/`disable` also act
 * on a connector with a stored preference or whose state cannot be read, so a skipped connector can never keep collecting (the
 * Copilot gate checks the preference before the scope). Throws when nothing is left to act on.
 */
export async function selectTargetConnectors(verb: AnalyticsVerb, opts: ConnectorOptions): Promise<TargetSelection> {
  if (hasConnectorFlag(opts)) {
    const id = resolveAnalyticsConnector(opts);
    const selected = ANALYTICS_CONNECTORS.filter((entry) => entry.id === id);
    return { targets: selected, unreadable: [] };
  }
  let targets: AnalyticsConnector[];
  let unreadable: AnalyticsConnector[] = [];
  if (verb === 'include' || verb === 'exclude') {
    targets = await listActiveAnalyticsConnectors();
  } else {
    const states = await Promise.all(ANALYTICS_CONNECTORS.map(connectorState));
    targets = ANALYTICS_CONNECTORS.filter((_, index) => states[index].active || states[index].hasPreference || states[index].unreadable);
    unreadable = ANALYTICS_CONNECTORS.filter((_, index) => states[index].unreadable);
  }
  if (targets.length === 0) {
    throw new ConfigurationError(
      renderHint({
        reason: 'No analytics connector is connected',
        command: `codemie proxy connect ${CONNECTOR_FLAGS.join(' | ')}`,
      })
    );
  }
  return { targets, unreadable };
}

/**
 * Runs `act` for every selected connector. Without a connector flag each connector gets its own
 * heading, a failure is reported and the next connector still runs, and the exit code is 1 when any
 * failed (as `disconnect --all` does). `act` resolves false when it reported "not done" without failing.
 * Resolves true when every connector succeeded.
 */
async function forEachTarget(
  verb: AnalyticsVerb,
  opts: ConnectorOptions,
  act: (connector: AnalyticsConnector) => Promise<boolean>
): Promise<boolean> {
  let selection: TargetSelection;
  try {
    selection = await selectTargetConnectors(verb, opts);
  } catch (error) {
    console.error(chalk.red(`✗ ${errorMessage(error)}`));
    process.exitCode = 1;
    return false;
  }
  const fanOut = !hasConnectorFlag(opts);
  let allSucceeded = true;
  for (const connector of selection.targets) {
    const label = storeForConnector(connector.id).label;
    if (fanOut) console.log(chalk.bold(`${label}:`));
    if (selection.unreadable.includes(connector)) {
      console.log(chalk.yellow(`${label}: its connector settings could not be read; saving its ${verb} preference anyway.`));
    }
    try {
      if (!(await act(connector))) allSucceeded = false;
    } catch (error) {
      allSucceeded = false;
      process.exitCode = 1;
      console.error(chalk.red(`✗ ${fanOut ? `${label}: ` : ''}${errorMessage(error)}`));
    }
  }
  return allSucceeded;
}

async function setEnabledFor(connectorId: AnalyticsConnectorId, enabled: boolean): Promise<boolean> {
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
    return true;
  }
  const resume = changed ? resumeNote(connectorId) : undefined;
  if (resume) {
    console.log(chalk.dim(resume));
  }
  await reportEffectiveState(connectorId, process.cwd());
  return true;
}

async function setEnabled(enabled: boolean, opts: ConnectorOptions): Promise<void> {
  const verb = enabled ? 'enable' : 'disable';
  const succeeded = await forEachTarget(verb, opts, (connector) => setEnabledFor(connector.id, enabled));
  if (succeeded) printNext(`proxy analytics ${verb}`);
}

async function excludeFor(connectorId: AnalyticsConnectorId, path: string | undefined): Promise<boolean> {
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
    return true;
  }
  printSaved(store, ` (project: ${canonical})`);
  console.log(chalk.dim(coverageNote(connectorId)));
  return true;
}

async function excludeProject(path: string | undefined, opts: ConnectorOptions): Promise<void> {
  await forEachTarget('exclude', opts, (connector) => excludeFor(connector.id, path));
}

/** An excluded entry other than `target` itself that still covers it, or undefined. */
async function findCoveringExclusion(excludedProjects: string[], target: string, canonical: string): Promise<string | undefined> {
  for (const entry of await removeProjectPath(excludedProjects, target)) {
    if (isPathInside(canonical, await canonicalizePath(entry))) {
      return entry;
    }
  }
  return undefined;
}

async function isListed(paths: string[], canonical: string): Promise<boolean> {
  for (const entry of paths) {
    if (isPathInside(canonical, await canonicalizePath(entry))) return true;
  }
  return false;
}

/**
 * Makes `path` tracked by one connector. In project scope the connector's own project list is written
 * first and the exclusion removed second, so a failure between them leaves the project still excluded
 * (never tracked by half a change) and a re-run finishes the job.
 */
async function includeFor(connector: AnalyticsConnector, path: string | undefined): Promise<boolean> {
  const connectorId = connector.id;
  const store = storeForConnector(connectorId);
  const target = path ?? resolveProjectRoot();
  const canonical = await canonicalizePath(target);
  const current = await store.read();
  const blockedBy = current ? await findCoveringExclusion(current.excludedProjects, target, canonical) : undefined;

  let added = false;
  const scope = await connector.readScope();
  if (!blockedBy && 'scope' in scope && scope.scope === 'project' && !(await isListed(scope.paths, canonical))) {
    try {
      await connector.addProject(target);
    } catch (error) {
      throw new ConfigurationError(
        `Could not add ${canonical} to the ${store.label} tracked projects: ${errorMessage(error)} Nothing was changed; a re-run is safe.`
      );
    }
    added = true;
    console.log(chalk.green(`✓ Added ${canonical} to the ${store.label} tracked projects.`));
  }

  let removed = true;
  let coveringParent: string | undefined;
  try {
    await store.update(async (prefs) => {
      const excludedProjects = await removeProjectPath(prefs.excludedProjects, target);
      removed = excludedProjects.length !== prefs.excludedProjects.length;
      // Checked against the list AFTER removal: a redundant entry nested under a
      // still-present parent must not be reported as "resumed" (CR-003 follow-up).
      coveringParent = await findCoveringExclusion(excludedProjects, target, canonical);
      return removed ? { ...prefs, excludedProjects } : prefs;
    });
  } catch (error) {
    if (!added) throw error;
    throw new ConfigurationError(
      `${canonical} was added to the ${store.label} tracked projects, but removing its exclusion failed: ${errorMessage(error)} ` +
        `Still owed: remove the exclusion. A re-run is safe: codemie proxy analytics include "${canonical}" --${connectorId}`
    );
  }
  if (coveringParent) {
    console.log(chalk.yellow(`${canonical} is not tracked: it is still excluded via ${coveringParent}.`));
    console.log(
      chalk.yellow(
        `  ${renderHint({ reason: 'To remove that exclusion', command: `codemie proxy analytics include "${coveringParent}" --${connectorId}` })}`
      )
    );
    return false;
  }
  if (removed) {
    printSaved(store, ` (project: ${canonical})`);
    const resume = resumeNote(connectorId);
    if (resume) {
      console.log(chalk.dim(resume));
    }
  } else if (!added) {
    console.log(chalk.dim('Nothing to change.'));
  }
  await reportEffectiveState(connectorId, canonical, store.label);
  return true;
}

async function includeProject(path: string | undefined, opts: ConnectorOptions): Promise<void> {
  await forEachTarget('include', opts, (connector) => includeFor(connector, path));
}

/** Delivery health of the running daemon, or `null` when it is stopped. */
async function collectStatusDelivery(): Promise<DeliveryHealth | null> {
  const { running, state } = await readDaemonStatus();
  if (!running || !state) {
    return null;
  }
  const health = await checkProxyHealth({ port: state.port, gatewayKey: state.gatewayKey, expectedPid: state.pid });
  return collectDeliveryHealth(state, health.analytics);
}

/**
 * The connectors the status reports on: the one the flag selects, or without a flag every connected
 * connector. When none is connected the default connector reports it is not connected.
 */
async function selectStatusConnectors(opts: ConnectorOptions, selected: AnalyticsConnector): Promise<AnalyticsConnector[]> {
  const flagGiven = Boolean(opts.claudeCodeOtlp || opts.copilotCliOtlp || opts.copilotChatOtlp);
  const connected = flagGiven ? [] : await listActiveAnalyticsConnectors();
  return connected.length > 0 ? connected : [selected];
}

async function showStatus(opts: ConnectorOptions & { json?: boolean }): Promise<void> {
  await withErrorHandling(async () => {
    const connectorId = resolveAnalyticsConnector(opts);
    const connector = ANALYTICS_CONNECTORS.find((entry) => entry.id === connectorId);
    if (!connector) {
      throw new ConfigurationError(`Unknown analytics connector: ${connectorId}`);
    }
    const shown = await selectStatusConnectors(opts, connector);
    const statuses = await Promise.all(shown.map(async (entry) => ({ entry, status: await entry.collect() })));
    const consentedFolders = (await listConsents()).map(({ folder, project }) => ({ folder, project }));
    if (opts.json) {
      // Delivery stays in the JSON for scripts (null unless a connector is connected and the daemon runs);
      // the text report leaves it to `proxy doctor`.
      const delivery = (await hasActiveAnalyticsConnector()) ? await collectStatusDelivery() : null;
      const connectors = statuses.map(({ entry, status }) => ({ ...status, connector: entry.id }));
      console.log(JSON.stringify({ delivery, connectors, consentedFolders }, null, 2));
      return;
    }
    const sections = await Promise.all(statuses.map(({ entry, status }) => entry.format(status)));
    const consentRow: ReportRow =
      consentedFolders.length === 0
        ? { message: 'Consented folders: none' }
        : { message: 'Consented folders:', items: consentedFolders.map((c) => `${c.folder} (${c.project})`) };
    const hint = renderHint({ reason: 'Delivery health', command: 'codemie proxy doctor' });
    console.log([...sections, [...formatReportRows([consentRow]), hint].join('\n')].join('\n\n'));
    printNext('proxy analytics status');
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
    const entries = await listConsents();
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

function withConnectorOptions(command: Command): Command {
  return command
    .option(`--${CLAUDE_CODE_OTLP_AGENT_NAME}`, 'Target Claude Code only')
    .option(`--${COPILOT_CLI_OTLP_AGENT_NAME}`, 'Target Copilot CLI only')
    .option(`--${COPILOT_CHAT_OTLP_AGENT_NAME}`, 'Target Copilot Chat (VS Code) only');
}

export function createProxyAnalyticsCommand(): Command {
  const analytics = new Command('analytics');
  analytics.description(
    'Turn analytics collection off/on, or exclude a single project (every connected connector by default; pass a connector flag for one)'
  );

  withConnectorOptions(
    analytics.command('disable').description('Stop all analytics collection (every connected connector, or the flagged one; hooks stay installed)')
  ).action((opts: ConnectorOptions) => setEnabled(false, opts));

  withConnectorOptions(analytics.command('enable').description('Resume analytics collection (every connected connector, or the flagged one)')).action(
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
      .description('Track a project again: remove its exclusion and, in project scope, add it to the tracked list (default: the current project root)')
  ).action((path: string | undefined, opts: ConnectorOptions) => includeProject(path, opts));

  const consent = new Command('consent').description('Manage work-project consent folders (Claude Code only)');
  addGrantOptions(
    consent.command('grant [path]').description('Authorize work-project analytics for a folder (default: the current project root); Claude Code only')
  ).action((path: string | undefined, opts: ConnectorOptions & { project?: string; yes?: boolean }) => connectWorkFolder(path, opts));
  withConnectorOptions(
    consent.command('revoke [path]').description('Withdraw work-project authorization for a folder (default: the current project root)')
  ).action((path: string | undefined, opts: ConnectorOptions) => disconnectWorkFolder(path, opts));
  consent.command('list').description('List every folder authorized for work-project analytics').action(() => listWorkConsents());
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

  withConnectorOptions(
    analytics.command('status').description('Show the effective analytics configuration for the connector')
  )
    .option('--json', 'Emit status as JSON instead of formatted output')
    .action((opts: ConnectorOptions & { json?: boolean }) => showStatus(opts));

  return analytics;
}
