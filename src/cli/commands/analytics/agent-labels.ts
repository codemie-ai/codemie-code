/**
 * Human-readable agent labels for analytics output.
 *
 * Agent keys are internal ids (`copilot-cli`); these are what a reader should see. Agents
 * whose key already reads acceptably are simply absent and fall through unchanged, so
 * adding an entry here is optional.
 *
 * NOTE: the HTML report's client bundle (`report/client/app.js`) carries its own copy of
 * this map. It is a standalone browser script and cannot import from TypeScript modules —
 * the same reason `AGENT_COLORS` lives only there. Keep the two in sync when adding an agent.
 */
const AGENT_LABELS: Record<string, string> = {
  'copilot-cli': 'GitHub Copilot CLI',
  pi: 'Pi',
};

/** Display label for an agent key; returns the key unchanged when unmapped. */
export function agentLabel(agentName: string): string {
  return AGENT_LABELS[agentName] ?? agentName;
}
