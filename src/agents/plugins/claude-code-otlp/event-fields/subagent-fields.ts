import { extractRepository } from '@/utils/paths.js';
import type { SubagentFile } from '../transcript/subagent-usage.js';

export interface SubagentStopFields {
  description: string;
  tool_use_id: string;
  spawn_depth?: number;
  worktree: string;
  started_at?: string;
  duration_ms?: number;
}

/**
 * Resolves the subagent-stop field set: description, tool use id, spawn depth, worktree, start
 * time, and duration. Description, tool use id, and worktree are always reported — worktree as
 * the repository identifier (`extractRepository`), matching `agent.subagent.usage` and the
 * event's own `cwd`, so no absolute path leaves the hook process. Start time and duration are
 * known only once the subagent's transcript has been summarized, and spawn depth only when the
 * sidecar carries it: an unknown value is omitted rather than defaulted to `0`/`''` (contract
 * rule 4).
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
    worktree: file.cwd ? extractRepository(file.cwd) : '',
    ...(typeof file.spawnDepth === 'number' ? { spawn_depth: file.spawnDepth } : {}),
    ...(typeof startedAt === 'string' ? { started_at: startedAt } : {}),
    ...(typeof durationMs === 'number' ? { duration_ms: durationMs } : {}),
  };
}
