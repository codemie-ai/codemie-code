/**
 * `codemie proxy analytics status` — the view half of AC3: effective scope, tracked/excluded
 * projects, the enabled flag, and whether the current directory is tracked right now and why.
 */

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
import { hasClaudeCodeOtlpHooks } from './connectors/claude-code-otlp.js';

export interface ClaudeAnalyticsStatus {
  hooksInstalled: boolean;
  scope: 'user' | 'project' | 'invalid' | 'not-configured';
  trackedProjects: string[];
  enabled: boolean;
  excludedProjects: string[];
  preferencesCorrupt: boolean;
  preferencesPath: string;
  current: { path: string; tracked: boolean; reason: ClaudeAnalyticsGateReason };
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
    current: { path: cwd, tracked: gateDecision.tracked, reason: gateDecision.reason },
  };
}

export function formatClaudeAnalyticsStatus(status: ClaudeAnalyticsStatus): string {
  const lines: string[] = [];
  lines.push(`Hooks: ${status.hooksInstalled ? 'installed' : 'not installed'}`);
  lines.push(`Scope: ${status.scope}`);
  if (status.scope === 'project') {
    lines.push('Tracked projects:');
    for (const path of status.trackedProjects) {
      lines.push(`  - ${path}`);
    }
  }
  lines.push(`Collection: ${status.enabled ? 'enabled' : 'disabled'}`);
  lines.push(
    status.excludedProjects.length > 0
      ? `Excluded projects:\n${status.excludedProjects.map((p) => `  - ${p}`).join('\n')}`
      : 'Excluded projects: (none)'
  );
  lines.push(
    `Current directory (${status.current.path}): ${status.current.tracked ? 'tracked' : `not tracked (${status.current.reason})`}`
  );
  if (!status.hooksInstalled) {
    lines.push('Run: codemie proxy connect --claude-code-otlp');
  }
  if (status.preferencesCorrupt) {
    lines.push(`Preferences file is corrupt — collection is stopped. Fix or delete ${status.preferencesPath}.`);
  }
  return lines.join('\n');
}
