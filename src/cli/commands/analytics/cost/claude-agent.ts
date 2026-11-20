/**
 * Agent-name helper for Claude-family analytics: Claude Code (`claude`), its ACP mode and
 * Claude Desktop, which share one transcript format and one set of usage readers.
 */

const CLAUDE_FAMILY = new Set(['claude', 'claude-acp', 'claude-desktop']);

/** True when analytics should use the Claude transcript readers for this agent name. */
export function isClaudeFamilyAgent(agentName: string | undefined): boolean {
  return CLAUDE_FAMILY.has((agentName ?? '').toLowerCase());
}
