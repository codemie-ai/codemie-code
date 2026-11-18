/**
 * Connector targeting shared by the `codemie proxy analytics` commands: which connector a flag picks, the
 * preference store of each connector, the fan-out over every connected connector, and the advisory
 * "is this project collected now" report.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { ConfigurationError } from '@/utils/errors.js';
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
import { renderHint } from '@/utils/hint.js';
import { adviceForReason } from './analytics-hints.js';
import { hasClaudeCodeOtlpHooks } from './connectors/claude-code-otlp.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import { ANALYTICS_CONNECTORS, listActiveAnalyticsConnectors, type AnalyticsConnector } from './analytics-connectors.js';
import { vendorFlags } from './flag-list.js';

export type AnalyticsConnectorId =
  | typeof CLAUDE_CODE_OTLP_AGENT_NAME
  | typeof COPILOT_CLI_OTLP_AGENT_NAME
  | typeof COPILOT_CHAT_OTLP_AGENT_NAME;

export interface ConnectorOptions {
  claudeCodeOtlp?: boolean;
  copilotCliOtlp?: boolean;
  copilotChatOtlp?: boolean;
}

interface AnalyticsPrefs {
  enabled: boolean;
  excludedProjects: string[];
}

export interface AnalyticsStore {
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

export function storeForConnector(connectorId: AnalyticsConnectorId): AnalyticsStore {
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

export function errorMessage(error: unknown): string {
  return error instanceof ConfigurationError ? error.message : error instanceof Error ? error.message : String(error);
}

export async function withErrorHandling(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof ConfigurationError ? error.message : String(error);
    console.error(chalk.red(`✗ ${message}`));
    process.exitCode = 1;
  }
}

export function printSaved(store: AnalyticsStore, suffix = ''): void {
  console.log(chalk.green(`✓ Saved to ${store.path()}. Applies to the next ${store.label} hook event.${suffix}`));
}

/**
 * Says whether `target` is collected right now and, if not, why and which command changes that.
 * `include`/`enable` only edit the opt-out layer; whether a project is collected at all also depends
 * on the connector scope written by `connect`, so this closes the gap between the two. Advisory
 * only: it reads state, never throws, and never changes the command's outcome. With `confirmLabel`
 * a tracked project is confirmed as tracked by that connector.
 */
export async function reportEffectiveState(connectorId: AnalyticsConnectorId, target: string, confirmLabel?: string): Promise<void> {
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

export type AnalyticsVerb = 'enable' | 'disable' | 'include' | 'exclude';

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
        command: `codemie proxy connect ${vendorFlags(CONNECTOR_FLAGS).join(' | ')}`,
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
export async function forEachTarget(
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

/** The connector flags every `proxy analytics` command takes. */
export function withConnectorOptions(command: Command): Command {
  return command
    .option(`--${CLAUDE_CODE_OTLP_AGENT_NAME}`, 'Target Claude Code only')
    .option(`--${COPILOT_CLI_OTLP_AGENT_NAME}`, 'Target Copilot CLI only')
    .option(`--${COPILOT_CHAT_OTLP_AGENT_NAME}`, 'Target Copilot Chat (VS Code) only');
}
