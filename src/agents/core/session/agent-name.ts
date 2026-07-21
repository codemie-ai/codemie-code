/**
 * Derive the wrapper agent name for session file storage.
 * CODEMIE_AGENT carries the short plugin name (e.g. 'claude') so that
 * AgentRegistry.getAgent() lookups and the backend API payload are unaffected.
 * Only the persisted session JSON uses the wrapper name.
 */
export function toWrapperAgentName(name: string): string {
  if (!name) return name;
  const normalized = name.toLowerCase().replace(/^codemie_/, 'codemie-');
  return normalized.startsWith('codemie-') ? normalized : `codemie-${normalized}`;
}
