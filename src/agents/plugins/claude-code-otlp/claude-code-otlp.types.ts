interface RawBaseClaudeCodeHookEvent {
  /** Current session identifier */
  session_id: string;

  /**
   * UUID identifying the user prompt currently being processed.
   * Matches the prompt.id attribute on OpenTelemetry events.
   * Absent until the first user input. Requires Claude Code v2.1.196 or later.
   */
  prompt_id?: string;

  /**
   * Path to conversation JSON. Written asynchronously and may lag
   * the in-memory conversation.
   */
  transcript_path: string;

  /** Current working directory when the hook is invoked */
  cwd: string;

  /**
   * Path to the session’s scratchpad directory for temporary working files.
   * Absent when no scratchpad exists or the temp directory is unavailable.
   * Requires Claude Code v2.1.257 or later.
   */
  scratchpad_dir?: string;

  /**
   * Current permission mode: "default", "plan", "acceptEdits", "auto",
   * "dontAsk", or "bypassPermissions". Not all events receive this field.
   */
  permission_mode?: "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";

  /**
   * Object with a level field holding the effort level in effect when the hook runs.
   * Present for events that fire within a tool-use context when supported by the model.
   */
  effort?: {
    level: "low" | "medium" | "high" | "xhigh" | "max";
  };

  /** Name of the event that fired */
  hook_event_name: string;
}

/**
 * camelCase-keyed mirror of {@link RawBaseClaudeCodeHookEvent}.
 */
interface BaseClaudeCodeHookEvent {
  sessionId: string;
  promptId?: string;
  transcriptPath: string;
  cwd: string;
  scratchpadDir?: string;
  permissionMode?: "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";
  effort?: {
    level: "low" | "medium" | "high" | "xhigh" | "max";
  };
  hookEventName: string;
}

export function toBaseClaudeCodeHookEvent(raw: RawBaseClaudeCodeHookEvent): BaseClaudeCodeHookEvent {
  return {
    sessionId: raw.session_id,
    promptId: raw.prompt_id,
    transcriptPath: raw.transcript_path,
    cwd: raw.cwd,
    scratchpadDir: raw.scratchpad_dir,
    permissionMode: raw.permission_mode,
    effort: raw.effort ? { level: raw.effort.level } : undefined,
    hookEventName: raw.hook_event_name,
  };
}

export type ForwardDecision =
  | { decision: 'forward'; payload: string }
  | { decision: 'block'; reason: string, hookSpecificOutput: Record<string, string | boolean> };
