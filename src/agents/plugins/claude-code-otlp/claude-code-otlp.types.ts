import type { ForwardDecision } from '@/agents/core/OtlpAgentAdapter.js';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import type { HookInput, UserPromptSubmitHookSpecificOutput } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeForwardDecision = ForwardDecision<UserPromptSubmitHookSpecificOutput>;

/**
 * Narrows parsed hook JSON to the SDK's `HookInput` union.
 *
 * Only the fields shared by every event (`BaseHookInput` plus the
 * discriminant) are verified at runtime. Event-specific fields are trusted
 * to match once `hook_event_name` is narrowed, and unknown event names are
 * accepted so a newer Claude Code does not break ingestion.
 *
 * A top-level `timestamp` key is rejected outright: Claude's `BaseHookInput` never carries
 * one, but VS Code Copilot Chat's Local hook schema does (a string ISO timestamp), and with
 * `chat.useClaudeHooks` on, VS Code runs this exact hook file. Without this check, a Chat
 * payload that happens to carry string `session_id`/`cwd`/`hook_event_name` fields (its
 * `SessionStart`/`UserPromptSubmit`/etc. event names collide with Claude's) would be wrongly
 * accepted and forwarded as a Claude Code session.
 */
export function isClaudeCodeHookInput(value: unknown): value is HookInput {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if ('timestamp' in candidate) {
    return false;
  }
  return (
    typeof candidate.session_id === 'string' &&
    isSafeSessionId(candidate.session_id) &&
    typeof candidate.cwd === 'string' &&
    typeof candidate.hook_event_name === 'string'
  );
}
