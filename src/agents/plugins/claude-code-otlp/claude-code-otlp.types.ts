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

  /** `SubagentStop`-only: path to the subagent's own transcript file. */
  agent_transcript_path?: string;

  /** `SubagentStop`-only: identifier of the subagent, when the hook payload carries one. */
  agent_id?: string;

  /** `SubagentStop`-only: the subagent's declared type (e.g. `explore`). */
  agent_type?: string;

  /** `SubagentStop`-only: the tool_use_id of the Task invocation that spawned the subagent. */
  tool_use_id?: string;
}

/**
 * camelCase-keyed mirror of {@link RawBaseClaudeCodeHookEvent}.
 */
export interface BaseClaudeCodeHookEvent {
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

  /** `SubagentStop`-only: path to the subagent's own transcript file. */
  agentTranscriptPath?: string;

  /** `SubagentStop`-only: identifier of the subagent, when the hook payload carries one. */
  agentId?: string;

  /** `SubagentStop`-only: the subagent's declared type (e.g. `explore`). */
  agentType?: string;

  /** `SubagentStop`-only: the tool_use_id of the Task invocation that spawned the subagent. */
  toolUseId?: string;
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
    agentTranscriptPath: raw.agent_transcript_path,
    agentId: raw.agent_id,
    agentType: raw.agent_type,
    toolUseId: raw.tool_use_id,
  };
}

export type ForwardDecision =
  | { decision: 'forward'; payload: string[] }
  | { decision: 'block'; reason: string, hookSpecificOutput: Record<string, string | boolean> };
