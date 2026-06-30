/**
 * Agent-name helpers for Codex-family analytics (native `codex` and `codemie-codex` wrapper).
 */

/** True when analytics should use Codex rollout parsers/readers for this agent name. */
export function isCodexFamilyAgent(agentName: string | undefined): boolean {
  const a = (agentName ?? '').toLowerCase();
  if (!a) {
    return false;
  }
  return a === 'codex' || a === 'codemie-codex' || a.includes('codex');
}

/** Match session agent against a CLI --agent filter (codex matches the whole family). */
export function agentMatchesAnalyticsFilter(sessionAgent: string, filterAgent: string): boolean {
  const filter = filterAgent.toLowerCase();
  const session = sessionAgent.toLowerCase();
  if (filter === 'codex') {
    return isCodexFamilyAgent(session);
  }
  if (filter === 'codemie-codex') {
    return session === 'codemie-codex';
  }
  return session === filter;
}
