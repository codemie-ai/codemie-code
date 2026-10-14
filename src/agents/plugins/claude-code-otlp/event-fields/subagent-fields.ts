import type { SubagentFile } from '../transcript/subagent-usage.js';

export interface SubagentStopFields {
  description: string;
  tool_use_id: string;
  workflow_run: string;
  spawn_depth: number;
  worktree: string;
  started_at: string;
  duration_ms: number;
}

/**
 * Resolves the subagent-stop field set: description, tool use id, workflow run, spawn depth,
 * worktree, start time, and duration. Description, tool use id, spawn depth, and worktree are
 * known from the subagent's own metadata and are always reported. Start time and duration are
 * known only once the subagent's transcript has been summarized; they default to an empty
 * string and zero when no summary is available for this invocation (e.g. an empty or missing
 * transcript). Workflow run has no available source and is always reported as an empty string.
 */
export function resolveSubagentStopFields(
  file: SubagentFile,
  derivedEvents: readonly Record<string, unknown>[]
): SubagentStopFields {
  const usage = derivedEvents.find((event) => event['type'] === 'agent.subagent.usage');
  const startedAt = usage?.['started_at'];
  const durationMs = usage?.['duration_ms'];
  return {
    description: file.description ?? '',
    tool_use_id: file.toolUseId ?? '',
    workflow_run: '',
    spawn_depth: file.spawnDepth ?? 0,
    worktree: file.cwd ?? '',
    started_at: typeof startedAt === 'string' ? startedAt : '',
    duration_ms: typeof durationMs === 'number' ? durationMs : 0,
  };
}
