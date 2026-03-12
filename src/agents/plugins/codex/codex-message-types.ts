// src/agents/plugins/codex/codex-message-types.ts
/**
 * TypeScript types for Codex rollout JSONL records.
 *
 * Codex writes rollout files at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-{ISO8601}-{uuid}.jsonl
 *
 * Each line is a JSON object (CodexRolloutRecord) with a `type` discriminator.
 *
 * Confirmed from codex-cli 0.79.0 rollout file inspection.
 *
 * References:
 * - https://github.com/openai/codex/blob/main/codex-rs/docs/cli-reference.md
 * - https://github.com/openai/codex/blob/main/codex-rs/docs/configuration.md
 */

/** Top-level wrapper for every JSONL line in a rollout file */
export interface CodexRolloutRecord {
  type: 'session_meta' | 'turn_context' | 'response_item' | 'event_msg';
  payload: CodexSessionMeta | CodexTurnContext | CodexResponseItem | CodexEventMsg;
}

/** session_meta record — appears once per rollout file */
export interface CodexSessionMeta {
  id: string;               // UUID (also embedded in filename)
  timestamp: string;        // ISO 8601 wall-clock time of session start
  cwd: string;
  originator?: string;
  cli_version?: string;
  model_provider?: string;  // Fallback model identifier (provider name, not full model ID)
  git?: {
    commit_hash?: string;
    branch?: string;
    repository_url?: string;
  };
}

/** turn_context record — may appear multiple times; last value wins for model extraction */
export interface CodexTurnContext {
  cwd: string;
  approval_policy?: string;
  sandbox_policy?: string;
  model?: string;           // Actual model string passed to the API (primary model source)
  summary?: string;
}

/**
 * response_item record — discriminated union on payload.type.
 * Relevant sub-types: function_call, function_call_output, message, reasoning.
 */
export interface CodexResponseItem {
  type: string;             // 'function_call' | 'function_call_output' | 'message' | 'reasoning' | 'ghost_snapshot'
  name?: string;            // function_call: tool name
  arguments?: string;       // function_call: JSON-encoded args string
  call_id?: string;         // function_call + function_call_output: shared correlation ID
  output?: string;          // function_call_output: tool output
}

/** event_msg record — user messages and other session events */
export interface CodexEventMsg {
  type: 'user_message' | string;
  message?: string;
}

/**
 * Extended ParsedSession metadata specific to the Codex plugin.
 * Consumed only within the codex plugin boundary.
 */
export interface CodexSessionMetadata {
  projectPath?: string;
  createdAt?: string;        // ISO 8601 from session_meta.timestamp
  repository?: string;
  branch?: string;
  codexSessionId: string;   // UUID from session_meta.id (unique per rollout file)
  model?: string;            // Resolved model string (turn_context.model or session_meta.model_provider)
  cliVersion?: string;
}

/**
 * Type guard: asserts metadata is CodexSessionMetadata.
 * Throws if required field codexSessionId is missing.
 */
export function validateCodexMetadata(metadata: unknown): asserts metadata is CodexSessionMetadata {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    typeof (metadata as CodexSessionMetadata).codexSessionId !== 'string'
  ) {
    throw new Error('Invalid Codex session metadata: codexSessionId is required');
  }
}

/**
 * Type guard: returns true if metadata has a valid codexSessionId field.
 */
export function hasCodexMetadata(metadata: unknown): metadata is CodexSessionMetadata {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    typeof (metadata as CodexSessionMetadata).codexSessionId === 'string'
  );
}
