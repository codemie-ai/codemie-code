/**
 * Human-readable agent labels for analytics output.
 *
 * Agent keys are internal ids (`codemie-code`, `copilot-cli`); these are the product names a
 * reader should see. Every key analytics can emit is listed, so labels share one casing
 * convention; an unknown key falls through unchanged.
 *
 * NOTE: the HTML report's client bundle (`report/client/app.js`) carries its own copy of
 * this map. It is a standalone browser script and cannot import from TypeScript modules —
 * the same reason `AGENT_COLORS` lives only there. Keep the two in sync when adding an agent.
 */
const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  'claude-acp': 'Claude Code ACP',
  'claude-desktop': 'Claude Desktop',
  'codemie-code': 'CodeMie Code',
  codex: 'Codex CLI',
  'codex-acp': 'Codex CLI ACP',
  'codemie-codex': 'CodeMie Codex',
  gemini: 'Gemini CLI',
  'gemini-acp': 'Gemini CLI ACP',
  opencode: 'OpenCode',
  'opencode-acp': 'OpenCode ACP',
  kimi: 'Kimi Code',
  'kimi-acp': 'Kimi Code ACP',
  openwiki: 'OpenWiki',
  'copilot-cli': 'GitHub Copilot CLI',
  pi: 'Pi',
  omp: 'Oh My Pi',
};

/** Display label for an agent key; returns the key unchanged when unmapped. */
export function agentLabel(agentName: string): string {
  return AGENT_LABELS[agentName] ?? agentName;
}
