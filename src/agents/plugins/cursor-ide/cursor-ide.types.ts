import type { BaseHookEvent } from '../../core/types.js';

/**
 * Raw payload shape Cursor sends on stdin for any of its 21 native hook
 * events. Cursor's hooks.json schema has no `env` key and every event
 * self-identifies via `hook_event_name` (the Cursor-native name, e.g.
 * `beforeShellExecution`) rather than one of CodeMie's internal names.
 *
 * Only the fields genuinely shared with other agents live on the shared
 * `BaseHookEvent` (`tool_name`, `tool_input`, `tool_output`, `tool_use_id`);
 * everything Cursor-specific stays here to avoid bloating the shared type.
 *
 * See: https://cursor.com/docs/hooks
 */
export interface CursorIdeHookEvent extends BaseHookEvent {
  /** Stable across every turn of one Cursor conversation - the correlation key. */
  conversation_id?: string;
  /** Per-generation id; used only as a last-resort session_id fallback. */
  generation_id?: string;

  /** Absolute paths of every workspace root open in this Cursor window. */
  workspace_roots?: string[];
  /** Signed-in Cursor account email, when available. */
  user_email?: string;

  /** Model metadata carried on most events. */
  model?: string;
  model_id?: string;
  model_params?: Record<string, unknown>;
  cursor_version?: string;

  /** Shell/MCP command text (beforeShellExecution, beforeMCPExecution). */
  command?: string;
  /** afterShellExecution result. */
  output?: unknown;
  /** afterMCPExecution result. */
  result_json?: unknown;

  /** postToolUseFailure fields. */
  error_message?: string;
  failure_type?: string;

  /** Timing/status fields present on several after-/before- event pairs. */
  duration?: number;
  duration_ms?: number;
  status?: string;

  /** subagentStart/subagentStop. */
  loop_count?: number;
  /** subagentStart's tool-call correlation id (normalized to tool_use_id). */
  tool_call_id?: string;

  /** beforeReadFile/beforeTabFileRead/afterFileEdit/afterTabFileEdit. */
  file_path?: string;

  /** beforeMCPExecution/afterMCPExecution. */
  mcp_server_name?: string;
  mcp_server_url?: string;

  /** beforeShellExecution sandbox descriptor, when sandboxing is enabled. */
  sandbox?: unknown;

  /** preCompact only - the sole Cursor event carrying token/cost data. */
  context_tokens?: number;
  context_window_size?: number;
  context_usage_percent?: number;
}
