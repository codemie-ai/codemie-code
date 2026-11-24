/**
 * Pi / oh-my-pi dispatch-timeline extraction.
 *
 * Skill events come straight from the named-invocation walk (zero duration — a skill load has
 * no end signal). Agent events come from the `task`/`subagent` tool call: when its result
 * carries `details.progress[]` (omp), each entry is one child run, timed by that child
 * transcript's own first/last entry and keyed by its task id; otherwise one event per
 * invocation, timed from call to result.
 */

import type { ParsedSession } from '../../../core/session/BaseSessionAdapter.js';
import type { DispatchEventRaw } from '../../../../cli/commands/analytics/cost/types.js';
import { MAX_DISPATCHES } from '../../../../cli/commands/analytics/cost/types.js';
import { PI_SUBAGENT_RUN, piConversationEntries } from '../pi.session.js';
import { isPiMessageEntry, isPiToolResultMessage, piEntryTimestamp, type PiEntry } from '../pi.types.js';
import { listPiInvocations, type PiInvocation } from './pi-named-invocations.js';

interface ToolResultInfo {
  ts: number | null;
  details: Record<string, unknown> | undefined;
}

function entryBounds(entries: readonly unknown[]): { start: number; end: number } | undefined {
  let start = Infinity;
  let end = -Infinity;
  for (const entry of entries) {
    const ts = piEntryTimestamp(entry);
    if (ts === null) continue;
    if (ts < start) start = ts;
    if (ts > end) end = ts;
  }
  return start <= end ? { start, end } : undefined;
}

function toolResults(entries: readonly unknown[]): Map<string, ToolResultInfo> {
  const results = new Map<string, ToolResultInfo>();
  for (const raw of entries) {
    const entry = raw as PiEntry;
    if (!isPiMessageEntry(entry) || !isPiToolResultMessage(entry.message)) continue;
    const details = entry.message.details;
    results.set(entry.message.toolCallId, {
      ts: piEntryTimestamp(raw),
      details: details && typeof details === 'object' ? (details as Record<string, unknown>) : undefined,
    });
  }
  return results;
}

function agentEvents(
  toolCallId: string,
  group: PiInvocation[],
  result: ToolResultInfo | undefined,
  children: Map<string, unknown[]>
): DispatchEventRaw[] {
  const callTs = group[0].timestamp;
  const progress = result?.details?.progress;
  const events: DispatchEventRaw[] = [];

  if (Array.isArray(progress) && progress.length > 0) {
    for (const item of progress) {
      if (!item || typeof item !== 'object') continue;
      const { id, agent } = item as { id?: unknown; agent?: unknown };
      if (typeof id !== 'string') continue;
      const bounds = entryBounds(children.get(id) ?? []);
      const start = bounds?.start ?? callTs;
      if (start === null) continue;
      const durationMs = bounds
        ? bounds.end - bounds.start
        : result?.ts != null && callTs !== null
          ? result.ts - callTs
          : 0;
      events.push({
        kind: 'agent',
        name: typeof agent === 'string' && agent.trim() ? agent.trim() : 'task',
        start,
        durationMs: Math.max(0, durationMs),
        id: `${toolCallId}:${id}`,
        _taskId: id,
      });
    }
    return events;
  }

  if (callTs === null) return events;
  group.forEach((invocation, index) => {
    events.push({
      kind: 'agent',
      name: invocation.name,
      start: callTs,
      durationMs: result?.ts != null ? Math.max(0, result.ts - callTs) : 0,
      id: `${toolCallId}:${index}`,
    });
  });
  return events;
}

/** Extract timed agent dispatches + skill events from a Pi / omp session. */
export function extractPiDispatchEvents(parsed: ParsedSession): DispatchEventRaw[] {
  const entries = piConversationEntries(parsed);
  const children = new Map<string, unknown[]>();
  for (const sub of parsed.subagents ?? []) {
    if (sub.agentType === PI_SUBAGENT_RUN && sub.agentId && Array.isArray(sub.messages)) {
      children.set(sub.agentId, sub.messages as unknown[]);
    }
  }

  const invocations = listPiInvocations(entries);
  const events: DispatchEventRaw[] = [];

  for (const invocation of invocations) {
    if (invocation.kind === 'skill' && invocation.timestamp !== null) {
      events.push({ kind: 'skill', name: invocation.name, start: invocation.timestamp, durationMs: 0 });
    }
  }

  const results = toolResults(entries);
  const groups = new Map<string, PiInvocation[]>();
  for (const invocation of invocations) {
    if (invocation.kind !== 'agent' || !invocation.toolCallId) continue;
    const group = groups.get(invocation.toolCallId);
    if (group) group.push(invocation);
    else groups.set(invocation.toolCallId, [invocation]);
  }
  for (const [toolCallId, group] of groups) {
    events.push(...agentEvents(toolCallId, group, results.get(toolCallId), children));
  }

  events.sort((a, b) => a.start - b.start || (a.id ?? '').localeCompare(b.id ?? ''));
  return events.slice(0, MAX_DISPATCHES);
}
