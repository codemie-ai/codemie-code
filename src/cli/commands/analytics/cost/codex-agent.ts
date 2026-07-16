/**
 * Agent-name helpers for analytics — family matching and CLI filter resolution.
 */

/** True when analytics should use Codex rollout parsers/readers for this agent name. */
export function isCodexFamilyAgent(agentName: string | undefined): boolean {
  const a = (agentName ?? '').toLowerCase();
  if (!a) {
    return false;
  }
  return a === 'codex' || a === 'codemie-codex' || a.includes('codex');
}

/** Internal: normalise legacy codemie_xxx → codemie-xxx (underscore form). */
function normalizeAgentId(name: string): string {
  return name.toLowerCase().replace(/^codemie_/, 'codemie-');
}

/**
 * Match session agent against a CLI --agent filter.
 *
 * Rules:
 * - `codex` filter: broad family match (legacy behaviour via isCodexFamilyAgent).
 * - `codemie-xxx` filter: exact wrapper match only (narrow).
 * - short-name filter (no prefix): matches both the short name AND `codemie-<short>`.
 * - Legacy `codemie_xxx` (underscore) in either position is normalised to `codemie-xxx`.
 */
export function agentMatchesAnalyticsFilter(sessionAgent: string | undefined, filterAgent: string): boolean {
  if (!sessionAgent) return false;
  const filter = normalizeAgentId(filterAgent);
  const session = normalizeAgentId(sessionAgent);

  // Legacy broad match: --agent codex matches all codex family variants
  if (filter === 'codex') {
    return isCodexFamilyAgent(session);
  }

  // Exact wrapper match: --agent codemie-xxx matches only codemie-xxx sessions.
  // native-loader synthesises sessions with agentName 'claude'/'codex' for bare
  // non-wrapper runs; keeping wrapper filters narrow prevents those from leaking in.
  if (filter.startsWith('codemie-')) {
    return session === filter;
  }

  // Short-name broad match: --agent claude matches 'claude' AND 'codemie-claude'.
  // Ensures backward compat after sessions switch to wrapper name storage.
  return session === filter || session === `codemie-${filter}`;
}
