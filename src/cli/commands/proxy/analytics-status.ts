/**
 * `codemie proxy analytics status` — the view half of AC3: effective scope, tracked/excluded
 * projects, the enabled flag, and whether the current directory is tracked right now and why.
 */

import chalk from 'chalk';
import {
  inferAllowlistScope,
  readAllowlistState,
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import {
  evaluateClaudeAnalyticsGate,
  type ClaudeAnalyticsGateReason,
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.gate.js';
import {
  getClaudeAnalyticsPreferencesPath,
  readClaudeAnalyticsPreferences,
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { hasClaudeCodeOtlpHooks } from './connectors/claude-code-otlp.js';
import { adviceForReason, unaffectedChannels } from './analytics-hints.js';
import {
  getCopilotAnalyticsPreferencesPath,
  readCopilotAnalyticsPreferences,
} from '@/agents/core/copilot-analytics-preferences.js';
import {
  evaluateCopilotAnalyticsGate,
  type CopilotAnalyticsGateReason,
} from '@/agents/core/copilot-analytics-gate.js';
import { readCopilotConnectorScope } from '@/agents/core/copilot-connector-scope.js';

const LABEL_WIDTH = 'Collection: '.length;

interface ConnectorSection {
  connectorId: string;
  /** Headline label ("Hooks", "Connected"), its value, and whether that value is the healthy one. */
  headline: { label: string; value: string; good: boolean };
  /** True when `connect` is the first thing to run (hooks missing / connector not connected). */
  needsConnect: boolean;
  scope: string;
  trackedProjects: string[];
  enabled: boolean;
  excludedProjects: string[];
  preferencesCorrupt: boolean;
  preferencesPath: string;
  current: { path: string; tracked: boolean; reason: string };
  /** Gate reasons the Run line or the corrupt-preferences line already explains, so no advice is looked up. */
  explainedReasons: readonly string[];
}

function detail(label: string, values: string[]): string[] {
  return values.map((value, index) => `  ${(index === 0 ? label : '').padEnd(LABEL_WIDTH)}${value}`);
}

/**
 * One layout for every connector: a headline with a coloured value, aligned 2-space-indented details,
 * at most one `Run:` line, then the channels these settings do not control as a plain dim sentence.
 */
function renderConnectorSection(section: ConnectorSection): string {
  const { current } = section;
  const advice =
    current.tracked || section.explainedReasons.includes(current.reason)
      ? undefined
      : adviceForReason(section.connectorId, current.reason, current.path);
  const reason = advice?.action ? `${current.reason}: ${advice.action}` : current.reason;
  const run = section.needsConnect ? `codemie proxy connect --${section.connectorId}` : advice?.command;

  const { label, value, good } = section.headline;
  const lines: string[] = [`${label}: ${good ? chalk.green(value) : chalk.yellow(value)}`];
  lines.push(...detail('Scope:', [section.scope]));
  if (section.scope === 'project') {
    lines.push(...detail('Tracked:', section.trackedProjects.length > 0 ? section.trackedProjects : ['(none)']));
  }
  lines.push(...detail('Collection:', [section.enabled ? 'enabled' : 'disabled']));
  lines.push(...detail('Excluded:', section.excludedProjects.length > 0 ? section.excludedProjects : ['(none)']));
  lines.push(...detail('Current:', [`${current.path}: ${current.tracked ? 'tracked' : `not tracked (${reason})`}`]));
  if (run) {
    lines.push(`  Run: ${run}`);
  }
  if (section.preferencesCorrupt) {
    lines.push(
      chalk.yellow(
        `  Preferences file is corrupt — collection is stopped. Fix or delete ${section.preferencesPath}.`
      )
    );
  }
  lines.push(chalk.dim(`These settings do not affect ${unaffectedChannels(section.connectorId)}.`));
  return lines.join('\n');
}

export interface ClaudeAnalyticsStatus {
  hooksInstalled: boolean;
  scope: 'user' | 'project' | 'invalid' | 'not-configured';
  trackedProjects: string[];
  enabled: boolean;
  excludedProjects: string[];
  preferencesCorrupt: boolean;
  preferencesPath: string;
  /** `hooks-not-installed`: the gate would track this directory, but no CodeMie hooks run at all. */
  current: { path: string; tracked: boolean; reason: ClaudeAnalyticsGateReason | 'hooks-not-installed' };
}

export async function collectClaudeAnalyticsStatus(cwd: string): Promise<ClaudeAnalyticsStatus> {
  const [hooksInstalled, allowlistState, preferences, gateDecision] = await Promise.all([
    hasClaudeCodeOtlpHooks(),
    readAllowlistState(),
    readClaudeAnalyticsPreferences(),
    evaluateClaudeAnalyticsGate(cwd),
  ]);

  const scope = hooksInstalled
    ? allowlistState.kind === 'invalid'
      ? 'invalid'
      : inferAllowlistScope(allowlistState)
    : 'not-configured';

  return {
    hooksInstalled,
    scope,
    trackedProjects: allowlistState.kind === 'valid' ? allowlistState.paths : [],
    enabled: preferences.kind === 'ok' ? preferences.value.enabled : false,
    excludedProjects: preferences.kind === 'ok' ? preferences.value.excludedProjects : [],
    preferencesCorrupt: preferences.kind === 'corrupt',
    preferencesPath: getClaudeAnalyticsPreferencesPath(),
    // The gate models opt-outs only; without installed hooks nothing is collected whatever it says.
    current:
      gateDecision.tracked && !hooksInstalled
        ? { path: cwd, tracked: false, reason: 'hooks-not-installed' }
        : { path: cwd, tracked: gateDecision.tracked, reason: gateDecision.reason },
  };
}

export function formatClaudeAnalyticsStatus(status: ClaudeAnalyticsStatus): string {
  return renderConnectorSection({
    connectorId: CLAUDE_CODE_OTLP_AGENT_NAME,
    headline: { label: 'Hooks', value: status.hooksInstalled ? 'installed' : 'not installed', good: status.hooksInstalled },
    needsConnect: !status.hooksInstalled,
    scope: status.scope,
    trackedProjects: status.trackedProjects,
    enabled: status.enabled,
    excludedProjects: status.excludedProjects,
    preferencesCorrupt: status.preferencesCorrupt,
    preferencesPath: status.preferencesPath,
    current: status.current,
    explainedReasons: ['preferences-corrupt', 'hooks-not-installed'],
  });
}

export interface CopilotAnalyticsStatus {
  connector: string;
  connected: boolean;
  scope: 'user' | 'project' | 'corrupt' | 'not-connected';
  trackedProjects: string[];
  enabled: boolean;
  excludedProjects: string[];
  preferencesCorrupt: boolean;
  preferencesPath: string;
  current: { path: string; tracked: boolean; reason: CopilotAnalyticsGateReason | 'tracked' };
}

export async function collectCopilotAnalyticsStatus(connectorId: string, cwd: string): Promise<CopilotAnalyticsStatus> {
  const [connectorScope, preferences, gateDecision] = await Promise.all([
    readCopilotConnectorScope(connectorId),
    readCopilotAnalyticsPreferences(connectorId),
    evaluateCopilotAnalyticsGate(connectorId, cwd),
  ]);

  let scope: CopilotAnalyticsStatus['scope'] = 'not-connected';
  let trackedProjects: string[] = [];
  if (connectorScope.kind === 'corrupt') {
    scope = 'corrupt';
  } else if (connectorScope.value.enabled) {
    scope = connectorScope.value.scope;
    trackedProjects = connectorScope.value.scope === 'project' ? connectorScope.value.paths : [];
  }

  return {
    connector: connectorId,
    connected: connectorScope.kind === 'ok' && connectorScope.value.enabled,
    scope,
    trackedProjects,
    enabled: preferences.kind === 'ok' ? preferences.value.enabled : false,
    excludedProjects: preferences.kind === 'ok' ? preferences.value.excludedProjects : [],
    preferencesCorrupt: preferences.kind === 'corrupt',
    preferencesPath: getCopilotAnalyticsPreferencesPath(),
    current: { path: cwd, tracked: gateDecision.tracked, reason: gateDecision.tracked ? 'tracked' : gateDecision.reason },
  };
}

export function formatCopilotAnalyticsStatus(status: CopilotAnalyticsStatus): string {
  return renderConnectorSection({
    connectorId: status.connector,
    headline: { label: 'Connected', value: status.connected ? 'yes' : 'no', good: status.connected },
    needsConnect: status.scope === 'not-connected',
    scope: status.scope,
    trackedProjects: status.trackedProjects,
    enabled: status.enabled,
    excludedProjects: status.excludedProjects,
    preferencesCorrupt: status.preferencesCorrupt,
    preferencesPath: status.preferencesPath,
    current: status.current,
    explainedReasons: ['scope-disabled', 'preferences-corrupt'],
  });
}
