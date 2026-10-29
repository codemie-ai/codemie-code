import type { ForwardDecision } from '@/agents/core/OtlpAgentAdapter.js';

export const CHAT_HOOK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
] as const;

export type ChatHookEventName = (typeof CHAT_HOOK_EVENT_NAMES)[number];

/**
 * VS Code Copilot Chat's "Local" hook schema (Preview). Field names mirror Claude Code's hook
 * input (same `session_id`/`cwd`/`tool_name`/`tool_input`/... naming), with two structural
 * differences the input guard below relies on to tell the hosts apart: a top-level `timestamp`
 * (string ISO; Claude's `BaseHookInput` never carries one). Session identity and cwd are
 * checked separately because they may be absent from recognized enforcement payloads.
 */
export interface CopilotChatHookInput {
  hook_event_name: ChatHookEventName;
  timestamp: string;
  session_id?: unknown;
  cwd?: unknown;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_response?: unknown;
  agent_id?: string;
  agent_type?: string;
  trigger?: string;
  [key: string]: unknown;
}

/** `{"continue": false, ...}` (SessionStart/UserPromptSubmit) or a deny (PreToolUse, defense in depth). */
export type ChatBlockOutput =
  | { continue: false; stopReason: string }
  | { permissionDecision: 'deny'; permissionDecisionReason: string };

export type ChatForwardDecision = ForwardDecision<ChatBlockOutput>;

const EVENT_NAME_SET: ReadonlySet<string> = new Set(CHAT_HOOK_EVENT_NAMES);

/**
 * Narrows parsed hook JSON to {@link CopilotChatHookInput}.
 *
 * A Claude Code payload never has `hook_event_name` carry one of these 8 names together with a
 * string `timestamp`, so it is naturally rejected here without needing to special-case Claude.
 * A Copilot CLI payload is rejected because its `timestamp` is numeric, not a string.
 */
export function isCopilotChatHookInput(value: unknown): value is CopilotChatHookInput {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.hook_event_name !== 'string' || !EVENT_NAME_SET.has(candidate.hook_event_name)) {
    return false;
  }
  if (typeof candidate.timestamp !== 'string') {
    return false;
  }
  return true;
}
