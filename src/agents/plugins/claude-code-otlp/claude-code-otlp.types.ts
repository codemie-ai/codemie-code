import type { ForwardDecision } from '@/agents/core/OtlpAgentAdapter.js';
import type { HookInput, UserPromptSubmitHookSpecificOutput } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeForwardDecision = ForwardDecision<UserPromptSubmitHookSpecificOutput>;

/**
 * Narrows parsed hook JSON to the SDK's `HookInput` union.
 *
 * Only the fields shared by every event (`BaseHookInput` plus the
 * discriminant) are verified at runtime. Event-specific fields are trusted
 * to match once `hook_event_name` is narrowed, and unknown event names are
 * accepted so a newer Claude Code does not break ingestion.
 */
export function isClaudeCodeHookInput(value: unknown): value is HookInput {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.session_id === 'string' &&
    typeof candidate.cwd === 'string' &&
    typeof candidate.hook_event_name === 'string'
  );
}
