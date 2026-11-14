/**
 * `codemie proxy analytics status` — the view half of AC3: effective scope, tracked/excluded
 * projects and the enabled flag of one connector, rendered as a plain section.
 */

import {
  inferAllowlistScope,
  readAllowlistState,
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import {
  getClaudeAnalyticsPreferencesPath,
  readClaudeAnalyticsPreferences,
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { resolveRepositoryName } from '@/utils/processes.js';
import { hasClaudeCodeOtlpHooks } from './connectors/claude-code-otlp.js';
import { unaffectedChannels } from './analytics-hints.js';
import { formatReportSection, type ReportRow } from './analytics-report.js';
import {
  getCopilotAnalyticsPreferencesPath,
  readCopilotAnalyticsPreferences,
} from '@/agents/core/copilot-analytics-preferences.js';
import { readCopilotConnectorScope } from '@/agents/core/copilot-connector-scope.js';

interface ConnectorSection {
  connectorId: string;
  /** Section heading: `Claude` or `Copilot`. */
  title: string;
  /** Headline label ("Hooks", "Connected") and its value. */
  headline: { label: string; value: string };
  /** True when `connect` is the first thing to run (hooks missing / connector not connected). */
  needsConnect: boolean;
  scope: string;
  trackedProjects: string[];
  enabled: boolean;
  excludedProjects: string[];
  preferencesCorrupt: boolean;
  preferencesPath: string;
}

/** A project list as rows: one analytics project name per line, or `none` when the list is empty. */
async function projectListRow(label: string, paths: string[]): Promise<ReportRow> {
  if (paths.length === 0) {
    return { message: `${label} none` };
  }
  return { message: label, items: await Promise.all(paths.map((path) => resolveRepositoryName(path))) };
}

/**
 * One layout for every connector: a headline, scope, tracked and excluded projects, the collection flag,
 * at most one `Run:` hint (connecting), then the channels these settings do not control.
 */
async function renderConnectorSection(section: ConnectorSection): Promise<string> {
  const rows: ReportRow[] = [
    {
      message: `${section.headline.label}: ${section.headline.value}`,
      ...(section.needsConnect ? { hint: `Run: codemie proxy connect --${section.connectorId}` } : {}),
    },
    { message: `Scope: ${section.scope}` },
  ];
  if (section.scope === 'project') {
    rows.push(await projectListRow('Tracked:', section.trackedProjects));
  }
  rows.push({ message: `Collection: ${section.enabled ? 'enabled' : 'disabled'}` });
  rows.push(await projectListRow('Excluded:', section.excludedProjects));
  if (section.preferencesCorrupt) {
    rows.push({
      message: 'Preferences file is corrupt — collection is stopped',
      hint: `Fix or delete ${section.preferencesPath}.`,
    });
  }
  return formatReportSection(
    section.title,
    rows,
    `These settings do not affect ${unaffectedChannels(section.connectorId)}.`
  ).join('\n');
}

export interface ClaudeAnalyticsStatus {
  hooksInstalled: boolean;
  scope: 'user' | 'project' | 'invalid' | 'not-configured';
  trackedProjects: string[];
  enabled: boolean;
  excludedProjects: string[];
  preferencesCorrupt: boolean;
  preferencesPath: string;
}

export async function collectClaudeAnalyticsStatus(): Promise<ClaudeAnalyticsStatus> {
  const [hooksInstalled, allowlistState, preferences] = await Promise.all([
    hasClaudeCodeOtlpHooks(),
    readAllowlistState(),
    readClaudeAnalyticsPreferences(),
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
  };
}

export function formatClaudeAnalyticsStatus(status: ClaudeAnalyticsStatus): Promise<string> {
  return renderConnectorSection({
    connectorId: CLAUDE_CODE_OTLP_AGENT_NAME,
    title: 'Claude',
    headline: { label: 'Hooks', value: status.hooksInstalled ? 'installed' : 'not installed' },
    needsConnect: !status.hooksInstalled,
    scope: status.scope,
    trackedProjects: status.trackedProjects,
    enabled: status.enabled,
    excludedProjects: status.excludedProjects,
    preferencesCorrupt: status.preferencesCorrupt,
    preferencesPath: status.preferencesPath,
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
}

export async function collectCopilotAnalyticsStatus(connectorId: string): Promise<CopilotAnalyticsStatus> {
  const [connectorScope, preferences] = await Promise.all([
    readCopilotConnectorScope(connectorId),
    readCopilotAnalyticsPreferences(connectorId),
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
  };
}

export function formatCopilotAnalyticsStatus(status: CopilotAnalyticsStatus): Promise<string> {
  return renderConnectorSection({
    connectorId: status.connector,
    title: 'Copilot',
    headline: { label: 'Connected', value: status.connected ? 'yes' : 'no' },
    needsConnect: status.scope === 'not-connected',
    scope: status.scope,
    trackedProjects: status.trackedProjects,
    enabled: status.enabled,
    excludedProjects: status.excludedProjects,
    preferencesCorrupt: status.preferencesCorrupt,
    preferencesPath: status.preferencesPath,
  });
}
