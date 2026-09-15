import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import { extractCodexDispatchEvents } from '@/agents/plugins/codex/session/codex-dispatch-extractor.js';
import { isCodexFamilyAgent } from './codex-agent.js';
import { buildClaudeTraceIndex, normalizeClaudeTrace, type ClaudeTraceIndex } from './claude-trace.js';
import { claudeBlocks, claudeTimestamp, type ClaudeNativeBlock, type ClaudeNativeRow } from './claude-native.js';
import type { DispatchEventRaw } from './types.js';

interface ToolOccurrence {
  row: ClaudeNativeRow;
  block: ClaudeNativeBlock;
  physicalOwner: string;
}

/** Invocation extraction completeness is independent of whether any timed steps were found. */
export interface DispatchExtraction {
  events: DispatchEventRaw[];
  complete: boolean;
}

function toolKind(block: ClaudeNativeBlock): { kind: 'agent' | 'skill'; name: string } | undefined {
  if (block.name === 'Agent' || block.name === 'Task') {
    const name = [block.input?.subagent_type, block.input?.name].find((value): value is string => typeof value === 'string' && !!value.trim())?.trim() ?? 'agent';
    return { kind: 'agent', name };
  }
  return block.name === 'Skill' ? { kind: 'skill', name: typeof block.input?.skill === 'string' ? block.input.skill.trim() || 'skill' : 'skill' } : undefined;
}

function toolOccurrences(index: ClaudeTraceIndex, type: string): Map<string, ToolOccurrence[]> {
  const occurrences = new Map<string, ToolOccurrence[]>();
  for (const owner of index.owners.values()) {
    for (const row of owner.messages as ClaudeNativeRow[]) {
      if (!row || typeof row !== 'object') continue;
      for (const block of claudeBlocks(row)) {
        const id = type === 'tool_use' ? block.id : block.tool_use_id;
        if (block.type !== type || !id) continue;
        const values = occurrences.get(id) ?? [];
        values.push({ row, block, physicalOwner: owner.id });
        occurrences.set(id, values);
      }
    }
  }
  return occurrences;
}

function preferredOccurrence(values: ToolOccurrence[], owner?: string): ToolOccurrence {
  return [...values].sort((left, right) => {
    const leftTimed = claudeTimestamp(left.row);
    const rightTimed = claudeTimestamp(right.row);
    if ((leftTimed === undefined) !== (rightTimed === undefined)) return leftTimed === undefined ? 1 : -1;
    const preference = Number(right.physicalOwner === owner) - Number(left.physicalOwner === owner);
    return preference || (leftTimed ?? 0) - (rightTimed ?? 0) || left.physicalOwner.localeCompare(right.physicalOwner);
  })[0];
}

function completeTool(event: DispatchEventRaw, occurrence: ToolOccurrence | undefined): DispatchEventRaw {
  if (!occurrence) return { ...event, status: event.kind === 'agent' ? 'unknown' : 'incomplete' };
  const { row, block } = occurrence;
  const acknowledgedAt = claudeTimestamp(row);
  const ack = row.toolUseResult;
  const failed = block.is_error === true || block.isError === true || block.status === 'failed'
    || ack?.is_error === true || ack?.isError === true || ack?.status === 'failed';
  const async = ack?.isAsync === true || ack?.status === 'async_launched';
  return {
    ...event, durationMs: acknowledgedAt === undefined ? 0 : Math.max(0, acknowledgedAt - event.start),
    ...(acknowledgedAt !== undefined && { acknowledgedAt }),
    ...(ack?.agentId && { agentId: ack.agentId }), ...(ack?.taskId && { _taskId: ack.taskId }),
    status: failed ? 'failed' : event.kind === 'agent' && async ? 'incomplete' : 'completed',
  };
}

function extractTools(index: ClaudeTraceIndex, result: DispatchExtraction): void {
  const results = toolOccurrences(index, 'tool_result');
  for (const [id, values] of toolOccurrences(index, 'tool_use')) {
    const ownerAgentId = index.toolOwners.get(id);
    const occurrence = preferredOccurrence(values, ownerAgentId);
    const kind = toolKind(occurrence.block);
    if (!kind) continue;
    const start = claudeTimestamp(occurrence.row);
    if (start === undefined) { result.complete = false; continue; }
    const event: DispatchEventRaw = {
      ...kind, start, durationMs: 0, id, _toolUseId: kind.kind === 'agent' ? id : undefined, ownerAgentId,
      relationshipStatus: ownerAgentId === undefined ? 'conflict' : ownerAgentId === index.rootOwnerId ? 'root' : 'resolved',
    };
    const matches = results.get(id);
    result.events.push(completeTool(event, matches ? preferredOccurrence(matches, ownerAgentId) : undefined));
  }
}

function commandNames(row: ClaudeNativeRow): string[] {
  if (row.message?.role !== 'user') return [];
  const content = row.message.content;
  const texts = typeof content === 'string' ? [content] : claudeBlocks(row).filter((block) => block.type === 'text').map((block) => block.text);
  return texts.flatMap((text) => {
    if (typeof text !== 'string' || !text.includes('<command-message>')) return [];
    return [...text.matchAll(/<command-name>([^<]+)<\/command-name>/g)].map((match) => match[1].replace(/^\//, '').trim()).filter(Boolean);
  });
}

function extractCommands(index: ClaudeTraceIndex, result: DispatchExtraction): void {
  const emitted = new Set<string>();
  const collisions = new Map<string, number>();
  for (const owner of index.owners.values()) {
    for (const row of owner.messages as ClaudeNativeRow[]) {
      if (!row || typeof row !== 'object') continue;
      const names = commandNames(row);
      if (!names.length) continue;
      const ownerAgentId = row.uuid ? index.messageOwners.get(row.uuid) : owner.id;
      if (row.uuid && ownerAgentId && ownerAgentId !== owner.id) continue;
      const start = claudeTimestamp(row);
      if (start === undefined) { result.complete = false; continue; }
      names.forEach((name, ordinal) => {
        const nativeId = row.uuid ? `command:${row.uuid}:${ordinal}` : undefined;
        if (nativeId && emitted.has(nativeId)) return;
        const fallback = `${owner.id}:command:${start}:${name}`;
        const count = collisions.get(fallback) ?? 0;
        const id = nativeId ?? `${fallback}${count ? `:${count}` : ''}`;
        collisions.set(fallback, count + 1);
        emitted.add(id);
        result.events.push({ kind: 'command', name, start, durationMs: 0, id, ownerAgentId,
          relationshipStatus: !ownerAgentId ? 'conflict' : ownerAgentId === index.rootOwnerId ? 'root' : 'resolved', status: 'completed', elapsedMs: 0 });
      });
    }
  }
}

function hasUnidentifiedTools(index: ClaudeTraceIndex): boolean {
  for (const owner of index.owners.values()) {
    for (const row of owner.messages as ClaudeNativeRow[]) {
      if (row && claudeBlocks(row).some((block) => block.type === 'tool_use' && !block.id && toolKind(block))) return true;
    }
  }
  return false;
}

/** Extract complete native invocations plus an honest flag for omissions with unavailable identity/timing. */
export function extractDispatchResult(parsed: ParsedSession, agentName?: string): DispatchExtraction {
  const agent = (agentName ?? parsed.agentName ?? '').toLowerCase();
  if (isCodexFamilyAgent(agent)) return { events: extractCodexDispatchEvents(parsed), complete: false };
  const index = buildClaudeTraceIndex(parsed);
  const result: DispatchExtraction = { events: [], complete: !hasUnidentifiedTools(index) };
  extractTools(index, result);
  extractCommands(index, result);
  result.events.sort((left, right) => left.start - right.start || (left.id ?? '').localeCompare(right.id ?? ''));
  return { events: normalizeClaudeTrace(result.events, parsed, index), complete: result.complete };
}

/** Compatibility entry point returning the invocation list. */
export function extractDispatchEvents(parsed: ParsedSession, agentName?: string): DispatchEventRaw[] {
  return extractDispatchResult(parsed, agentName).events;
}
