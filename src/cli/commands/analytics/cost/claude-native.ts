/** Fields retained from Claude protocol rows for ownership and lifecycle analysis. */
export interface ClaudeNativeBlock {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  input?: { skill?: unknown; subagent_type?: unknown; name?: unknown };
  text?: unknown;
  is_error?: boolean;
  isError?: boolean;
  status?: string;
}

/** Exact launch identities are independent of child transcript availability. */
export interface ClaudeAcknowledgement {
  agentId?: string;
  taskId?: string;
}

/** Minimal native envelope shared by the trace readers. */
export interface ClaudeNativeRow {
  uuid?: string;
  requestId?: string;
  type?: string;
  subtype?: string;
  operation?: string;
  timestamp?: string;
  taskId?: string;
  task_id?: string;
  toolUseId?: string;
  tool_use_id?: string;
  status?: string;
  content?: unknown;
  toolUseResult?: ClaudeAcknowledgement & { isAsync?: boolean; status?: string; is_error?: boolean; isError?: boolean };
  message?: { id?: string; role?: string; content?: unknown };
}

/** Parse a timestamp without manufacturing timing for omitted/malformed values. */
export function claudeTimestamp(row: ClaudeNativeRow): number | undefined {
  const time = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  return Number.isFinite(time) ? time : undefined;
}

/** Read Claude message blocks, excluding malformed scalar content. */
export function claudeBlocks(row: ClaudeNativeRow): ClaudeNativeBlock[] {
  return Array.isArray(row.message?.content) ? row.message.content as ClaudeNativeBlock[] : [];
}

/** Native response identity used for both cross-file usage deduplication and ownership. */
export function claudeResponseKey(row: ClaudeNativeRow): string | undefined {
  return row.message?.id || row.requestId ? `${row.message?.id ?? ''}::${row.requestId ?? ''}` : undefined;
}
