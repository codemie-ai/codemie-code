/**
 * Single analytics gate for Claude Code OTLP: combines the new CodeMie-owned preferences
 * (disabled flag, project exclusions) with the existing `~/.claude/settings.json` allowlist.
 * `ClaudeCodeOtlpPlugin.isTracked()` delegates to this — the sole choke point
 * `OtlpAgentAdapter.processOtlpEvent` already guarantees runs before the daemon, SSO, and any
 * spool write, so every rule here inherits that invariant for free.
 */

import { isProjectTracked, readAllowlistState } from './claude-code-otlp.allowlist.js';
import { isProjectExcluded, readClaudeAnalyticsPreferences } from './claude-code-otlp.preferences.js';

export type ClaudeAnalyticsGateReason =
  | 'tracked'
  | 'preferences-corrupt'
  | 'disabled'
  | 'project-excluded'
  | 'not-in-allowlist';

export interface ClaudeAnalyticsGateDecision {
  tracked: boolean;
  reason: ClaudeAnalyticsGateReason;
}

export async function evaluateClaudeAnalyticsGate(cwd: string | undefined): Promise<ClaudeAnalyticsGateDecision> {
  const preferences = await readClaudeAnalyticsPreferences();
  if (preferences.kind === 'corrupt') {
    return { tracked: false, reason: 'preferences-corrupt' };
  }
  if (!preferences.value.enabled) {
    return { tracked: false, reason: 'disabled' };
  }
  if (await isProjectExcluded(cwd, preferences.value.excludedProjects)) {
    return { tracked: false, reason: 'project-excluded' };
  }
  if (!(await isProjectTracked(cwd, await readAllowlistState()))) {
    return { tracked: false, reason: 'not-in-allowlist' };
  }
  return { tracked: true, reason: 'tracked' };
}
