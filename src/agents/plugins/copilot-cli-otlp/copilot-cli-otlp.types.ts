import type { ForwardDecision } from '@/agents/core/OtlpAgentAdapter.js';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import { CLI_HOOK_EVENT_NAMES } from './copilot-cli-otlp.constants.js';

export type CliEventName = (typeof CLI_HOOK_EVENT_NAMES)[number];

/**
 * GitHub Copilot CLI's native hook payload (camelCase, numeric epoch-ms `timestamp`, no
 * event-name field). Event-specific field names below mirror the documented hook payloads.
 */
export interface CopilotCliHookInput {
  sessionId: string;
  cwd: string;
  timestamp: number;
  /** Injected by `codemie hook --event <name>` (see `hook.ts`); never present on the wire. */
  codemieEventName: CliEventName;

  // sessionStart
  source?: string;
  // sessionEnd
  reason?: string;
  // userPromptTransformed — the ORIGINAL prompt (bounded ≤200 by the base class), never the
  // unbounded transformed text.
  prompt?: string;
  // preToolUse / postToolUse / postToolUseFailure
  toolName?: string;
  toolArgs?: unknown;
  toolCallId?: string;
  toolResult?: { textResultForLlm?: string };
  // postToolUseFailure / errorOccurred
  error?: unknown;
  errorContext?: unknown;
  recoverable?: boolean;
  // subagentStart / subagentStop
  agentName?: string;
  agentId?: string;
  agentType?: string;
  // preCompact
  trigger?: string;
  // notification
  title?: string;
  notification_type?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * `{"modifiedTransformedPrompt": ...}` (userPromptTransformed) or a deny (preToolUse).
 * `modifiedTransformedPrompt` must be a fixed, non-empty notice — GitHub rejects an empty
 * string, and the notice is "replayed unchanged if the session is resumed" per the CLI docs.
 */
export type CliBlockOutput =
  | { modifiedTransformedPrompt: string }
  | { permissionDecision: 'deny'; permissionDecisionReason: string };

export type CliForwardDecision = ForwardDecision<CliBlockOutput>;

const EVENT_NAME_SET: ReadonlySet<string> = new Set(CLI_HOOK_EVENT_NAMES);

/**
 * Narrows parsed hook JSON to {@link CopilotCliHookInput}.
 *
 * The CLI's hook file can also be invoked by VS Code Local when it maps an entry
 * (e.g. `preToolUse` -> `PreToolUse`) — but VS Code sends the Local schema with a STRING
 * `timestamp`, so the strict `typeof === 'number'` check below rejects it as "not my host"
 * without needing to special-case VS Code.
 */
export function isCopilotCliHookInput(value: unknown): value is CopilotCliHookInput {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.sessionId !== 'string' || !isSafeSessionId(candidate.sessionId)) {
    return false;
  }
  if (typeof candidate.cwd !== 'string' || candidate.cwd.length === 0) {
    return false;
  }
  if (typeof candidate.timestamp !== 'number') {
    return false;
  }
  if (typeof candidate.codemieEventName !== 'string' || !EVENT_NAME_SET.has(candidate.codemieEventName)) {
    return false;
  }
  return true;
}
