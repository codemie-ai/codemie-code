/**
 * Decision gate composing the new `copilot-analytics.json` preferences with the existing
 * `CopilotConnectorScope` tracked/untracked check. Precedence (first match wins):
 * preferences-corrupt > analytics-disabled > project-excluded > scope-corrupt > scope-disabled >
 * scope-untracked > tracked. Mirrors `claude-code-otlp.gate.ts`'s precedence shape; the
 * scope-* reasons exist purely so `onUntrackedHook()` callers can build the same messages the
 * existing scope-based code already builds, without re-deriving that logic themselves.
 */

import { isCopilotAnalyticsProjectExcluded, readCopilotAnalyticsPreferences } from './copilot-analytics-preferences.js';
import { isCopilotProjectTracked, readCopilotConnectorScope } from './copilot-connector-scope.js';

export type CopilotAnalyticsGateReason =
  | 'preferences-corrupt'
  | 'analytics-disabled'
  | 'project-excluded'
  | 'scope-corrupt'
  | 'scope-disabled'
  | 'scope-untracked';

export type CopilotAnalyticsGateDecision = { tracked: true } | { tracked: false; reason: CopilotAnalyticsGateReason };

export async function evaluateCopilotAnalyticsGate(
  connectorId: string,
  cwd: string | undefined
): Promise<CopilotAnalyticsGateDecision> {
  const prefs = await readCopilotAnalyticsPreferences(connectorId);
  if (prefs.kind === 'corrupt') {
    return { tracked: false, reason: 'preferences-corrupt' };
  }
  if (!prefs.value.enabled) {
    return { tracked: false, reason: 'analytics-disabled' };
  }
  if (await isCopilotAnalyticsProjectExcluded(cwd, prefs.value.excludedProjects)) {
    return { tracked: false, reason: 'project-excluded' };
  }

  const scope = await readCopilotConnectorScope(connectorId);
  if (scope.kind === 'corrupt') {
    return { tracked: false, reason: 'scope-corrupt' };
  }
  if (!scope.value.enabled) {
    return { tracked: false, reason: 'scope-disabled' };
  }
  if (!(await isCopilotProjectTracked(cwd, scope))) {
    return { tracked: false, reason: 'scope-untracked' };
  }

  return { tracked: true };
}
