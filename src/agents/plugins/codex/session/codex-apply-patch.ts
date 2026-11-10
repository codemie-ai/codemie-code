/**
 * Shared apply_patch handling for Codex rollouts.
 *
 * One place owns patch parsing, call/result pairing and recognition of apply_patch calls, so the
 * parse-time extractor and the incremental metrics processor report the same file operations.
 */

import type { FileOperation } from '../../../core/metrics/types.js';
import type { CodexRolloutRecord } from '../codex-message-types.js';

export interface ApplyPatchCall {
  callId: string;
  /** Record timestamp of the call line, when the rollout carries one */
  timestamp?: string;
  /** false: the patch failed (apply end event or tool output said so) */
  ok: boolean;
  /** File operations of the patch; empty for a failed call */
  fileOperations: FileOperation[];
}

interface ApplyPatchItem {
  type?: string;
  name?: string;
  call_id?: string;
  input?: string;
  arguments?: string;
  output?: unknown;
  success?: boolean;
}

/** True for an apply_patch call, whatever item type carries it. */
export function isApplyPatchItem(item: { type?: string; name?: string }): boolean {
  return (item.type === 'custom_tool_call' || item.type === 'function_call') && item.name === 'apply_patch';
}

/**
 * Parse a Codex `apply_patch` envelope into per-file operations. Add = write, Update = edit,
 * Delete = delete; an Update with `*** Move to:` is one edit under the new path. Added/removed
 * lines are attributed to the file whose header they follow.
 */
export function parseApplyPatch(patch: string): FileOperation[] {
  const ops: FileOperation[] = [];
  let current: { op: FileOperation; added: number; removed: number } | null = null;
  const flush = (): void => {
    if (current) {
      current.op.linesAdded = current.added;
      current.op.linesRemoved = current.removed;
      current.op.linesModified = current.added + current.removed;
      ops.push(current.op);
      current = null;
    }
  };
  for (const line of patch.split('\n')) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line.trim());
    if (header) {
      flush();
      const type = header[1] === 'Add' ? 'write' : header[1] === 'Delete' ? 'delete' : 'edit';
      current = { op: { type, path: header[2].trim() }, added: 0, removed: 0 };
      continue;
    }
    if (!current) {
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line.trim());
    if (move) {
      current.op.path = move[1].trim();
    } else if (line.startsWith('+')) {
      current.added += 1;
    } else if (line.startsWith('-')) {
      current.removed += 1;
    }
  }
  flush();
  return ops;
}

function patchText(item: ApplyPatchItem): string | undefined {
  if (typeof item.input === 'string') {
    return item.input;
  }
  if (typeof item.arguments !== 'string') {
    return undefined;
  }
  try {
    const args = JSON.parse(item.arguments) as { input?: unknown; patch?: unknown } | string;
    if (typeof args === 'string') return args;
    if (typeof args.input === 'string') return args.input;
    if (typeof args.patch === 'string') return args.patch;
  } catch {
    // arguments may carry the raw patch
    return item.arguments;
  }
  return undefined;
}

/** A tool output that reports failure: non-zero exit code, or error text. */
function outputFailed(output: unknown): boolean {
  let text = typeof output === 'string' ? output : '';
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output) as { output?: unknown; metadata?: { exit_code?: unknown } } | null;
      if (parsed && typeof parsed === 'object') {
        const exit = parsed.metadata?.exit_code;
        if (typeof exit === 'number' && exit !== 0) return true;
        if (typeof parsed.output === 'string') text = parsed.output;
      }
    } catch {
      // plain text output
    }
  } else if (output && typeof output === 'object') {
    const obj = output as { metadata?: { exit_code?: unknown }; output?: unknown };
    const exit = obj.metadata?.exit_code;
    if (typeof exit === 'number' && exit !== 0) return true;
    if (typeof obj.output === 'string') text = obj.output;
  }
  return /^\s*(error|failed|apply_patch (verification )?failed)|verification failed/i.test(text);
}

/**
 * Apply_patch calls of a rollout with their outcome. Result order per call_id: apply end event,
 * then tool output, else the call is pending and omitted. Calls in `skip` are neither parsed nor returned.
 */
export function collectApplyPatchCalls(records: CodexRolloutRecord[], skip?: Set<string>): ApplyPatchCall[] {
  const calls: Array<{ callId: string; item: ApplyPatchItem; timestamp?: string }> = [];
  const seen = new Set<string>();
  const endSuccess = new Map<string, boolean>();
  const outputs = new Map<string, unknown>();

  for (const record of records) {
    const payload = record.payload as ApplyPatchItem | undefined;
    if (!payload?.type || !payload.call_id) continue;
    if (record.type === 'event_msg') {
      if (payload.type === 'patch_apply_end' && typeof payload.success === 'boolean' && !endSuccess.has(payload.call_id)) {
        endSuccess.set(payload.call_id, payload.success);
      }
    } else if (record.type === 'response_item') {
      if (isApplyPatchItem(payload)) {
        if (!seen.has(payload.call_id)) {
          seen.add(payload.call_id);
          calls.push({ callId: payload.call_id, item: payload, timestamp: record.timestamp });
        }
      } else if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
        if (!outputs.has(payload.call_id)) outputs.set(payload.call_id, payload.output);
      }
    }
  }

  const result: ApplyPatchCall[] = [];
  for (const { callId, item, timestamp } of calls) {
    if (skip?.has(callId)) continue;
    let ok: boolean;
    if (endSuccess.has(callId)) {
      ok = endSuccess.get(callId) as boolean;
    } else if (outputs.has(callId)) {
      ok = !outputFailed(outputs.get(callId));
    } else {
      continue;
    }
    const text = ok ? patchText(item) : undefined;
    result.push({ callId, timestamp, ok, fileOperations: text ? parseApplyPatch(text) : [] });
  }
  return result;
}
