/**
 * Parse-time metrics extraction for Codex rollout JSONL.
 *
 * Aggregates tools, file operations, and named invocations for analytics re-parse
 * (native-loader synthesis and cost enrichment).
 */

import type { FileOperation } from '../../../core/metrics/types.js';
import type { CodexRolloutRecord } from '../codex-message-types.js';
import { extractCodexNamedInvocations } from './codex-named-invocations.js';

interface ResponseItemPayload {
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  input?: string;
  output?: string;
  status?: string;
}

/**
 * Parse a Codex `apply_patch` envelope into per-file operations. Handles Add / Update / Delete
 * headers and attributes added/removed lines to the file they appear under (the patch groups
 * hunks beneath each `*** <Op> File:` header), instead of splitting a session-wide total evenly.
 */
function fileOpsFromPatch(patch: string): FileOperation[] {
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
      current = {
        op: { type: header[1] === 'Delete' ? 'delete' : 'edit', path: header[2].trim() },
        added: 0,
        removed: 0,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.added += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.removed += 1;
    }
  }
  flush();
  return ops;
}

/** Tool + file-op + named-invocation metrics from rollout records. */
export function extractCodexMetrics(records: CodexRolloutRecord[]): ParsedSessionMetrics {
  const toolCounts: Record<string, number> = {};
  const toolStatus: Record<string, { success: number; failure: number }> = {};
  const fileOperations: FileOperation[] = [];
  const callTool = new Map<string, string>();
  const resolved = new Set<string>();

  for (const record of records) {
    if (record.type === 'event_msg') {
      // spawn_agent / wait_agent (and async exec_command) complete via collaboration / lifecycle
      // events rather than a function_call_output. Credit their success here so the
      // unresolved→failure backfill below does not mislabel them. `resolved` dedupes against a
      // later function_call_output for the same call.
      const ev = record.payload as { type?: string; call_id?: string } | undefined;
      const callId = ev?.call_id;
      if (
        callId &&
        !resolved.has(callId) &&
        (ev?.type === 'collab_agent_spawn_end' || ev?.type === 'collab_waiting_end' || ev?.type === 'exec_command_end')
      ) {
        const toolName = callTool.get(callId);
        if (toolName && toolStatus[toolName]) {
          toolStatus[toolName].success += 1;
          resolved.add(callId);
        }
      }
      continue;
    }
    if (record.type !== 'response_item') {
      continue;
    }
    const item = record.payload as ResponseItemPayload;
    if (!item?.type) {
      continue;
    }

    if (item.type === 'function_call' && item.call_id && item.name) {
      const toolName = item.name.toLowerCase();
      toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
      if (!toolStatus[toolName]) {
        toolStatus[toolName] = { success: 0, failure: 0 };
      }
      callTool.set(item.call_id, toolName);
    } else if (item.type === 'function_call_output' && item.call_id) {
      if (!resolved.has(item.call_id)) {
        const toolName = callTool.get(item.call_id);
        if (toolName && toolStatus[toolName]) {
          toolStatus[toolName].success += 1;
          resolved.add(item.call_id);
        }
      }
    } else if (item.type === 'custom_tool_call' && item.name === 'apply_patch' && item.input) {
      toolCounts.apply_patch = (toolCounts.apply_patch || 0) + 1;
      if (!toolStatus.apply_patch) {
        toolStatus.apply_patch = { success: 0, failure: 0 };
      }
      if (item.status === 'completed' || !item.status) {
        toolStatus.apply_patch.success += 1;
      } else {
        toolStatus.apply_patch.failure += 1;
      }
      fileOperations.push(...fileOpsFromPatch(item.input));
    }
  }

  for (const [toolName, count] of Object.entries(toolCounts)) {
    const status = toolStatus[toolName];
    if (!status) {
      continue;
    }
    const unresolved = count - status.success - status.failure;
    if (unresolved > 0) {
      status.failure += unresolved;
    }
  }

  const named = extractCodexNamedInvocations(records);

  return {
    tools: toolCounts,
    toolStatus,
    fileOperations,
    ...(Object.keys(named.skillInvocations).length > 0 && { skillInvocations: named.skillInvocations }),
    ...(Object.keys(named.agentInvocations).length > 0 && { agentInvocations: named.agentInvocations }),
    ...(Object.keys(named.commandInvocations).length > 0 && { commandInvocations: named.commandInvocations }),
  };
}

export interface ParsedSessionMetrics {
  tools: Record<string, number>;
  toolStatus: Record<string, { success: number; failure: number }>;
  fileOperations: FileOperation[];
  skillInvocations?: Record<string, number>;
  agentInvocations?: Record<string, number>;
  commandInvocations?: Record<string, number>;
}
