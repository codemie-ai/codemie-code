import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import type { DispatchEventRaw } from './types.js';
import { claudeTimestamp, type ClaudeNativeRow } from './claude-native.js';
import { buildClaudeTraceIndex, type ClaudeTraceIndex } from './claude-trace.js';

interface LifecycleEvent {
  at: number;
  status: 'completed' | 'failed';
  toolUseId?: string;
  taskId?: string;
}

function xmlValue(text: string, name: string): string | undefined {
  return new RegExp(`<${name}>([^<]+)</${name}>`).exec(text)?.[1]?.trim();
}

function protocolEvent(row: ClaudeNativeRow): LifecycleEvent | undefined {
  const at = claudeTimestamp(row);
  if (at === undefined) return undefined;
  let taskId: string | undefined;
  let toolUseId: string | undefined;
  let status: string | undefined;
  if (row.type === 'system' && row.subtype === 'task-notification') {
    taskId = row.taskId ?? row.task_id;
    toolUseId = row.toolUseId ?? row.tool_use_id;
    status = row.status;
  } else if (row.type === 'queue-operation' && (row.operation === 'enqueue' || row.operation === undefined)) {
    const content = typeof row.content === 'string' ? row.content : typeof row.message?.content === 'string' ? row.message.content : '';
    if (!content.trimStart().startsWith('<task-notification>')) return undefined;
    taskId = xmlValue(content, 'task-id');
    toolUseId = xmlValue(content, 'tool-use-id');
    status = xmlValue(content, 'status');
  }
  if ((!taskId && !toolUseId) || (status !== 'completed' && status !== 'failed')) return undefined;
  return { at, status, taskId, toolUseId };
}

function lifecycleEvents(index: ClaudeTraceIndex): LifecycleEvent[] {
  const unique = new Map<string, LifecycleEvent>();
  for (const owner of index.owners.values()) {
    for (const row of owner.messages as ClaudeNativeRow[]) {
      if (!row || typeof row !== 'object') continue;
      const event = protocolEvent(row);
      if (!event) continue;
      const key = `${event.toolUseId ?? ''}::${event.taskId ?? ''}`;
      const previous = unique.get(key);
      if (!previous || event.at < previous.at) unique.set(key, event);
    }
  }
  return [...unique.values()].sort((left, right) => left.at - right.at);
}

function observedEnd(agentId: string, index: ClaudeTraceIndex): number | undefined {
  const seen = new Set<string>();
  const pending = [agentId];
  let end: number | undefined;
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const row of (index.owners.get(current)?.messages ?? []) as ClaudeNativeRow[]) {
      if (!row || typeof row !== 'object') continue;
      const at = claudeTimestamp(row);
      if (at !== undefined) end = Math.max(end ?? at, at);
    }
    for (const child of index.childAgentsByOwner.get(current) ?? []) pending.push(child);
  }
  return end;
}

function taskIdentities(event: DispatchEventRaw, index: ClaudeTraceIndex): Set<string> {
  const ack = event.id ? index.acknowledgements.get(event.id) : undefined;
  const agentIds = event.id ? index.agentsByTool.get(event.id) ?? [] : [];
  return new Set([event.agentId, event._taskId, ack?.agentId, ack?.taskId, ...agentIds].filter((id): id is string => !!id));
}

function matchesLifecycle(notification: LifecycleEvent, event: DispatchEventRaw, index: ClaudeTraceIndex): boolean {
  if (!event.id || index.conflictingTools.has(event.id) || notification.at < event.start) return false;
  const identities = taskIdentities(event, index);
  if (notification.toolUseId && notification.toolUseId !== event.id) return false;
  if (notification.taskId && identities.size && !identities.has(notification.taskId)) return false;
  return notification.toolUseId === event.id || (!!notification.taskId && identities.has(notification.taskId));
}

function normalizeEvent(event: DispatchEventRaw, index: ClaudeTraceIndex, lifecycle: LifecycleEvent[]): DispatchEventRaw {
  const claimants = event.kind === 'agent' && event.id ? index.agentsByTool.get(event.id) ?? [] : [];
  const agent = claimants.length === 1 ? index.agents.get(claimants[0]) : undefined;
  const conflict = !!event.id && index.conflictingTools.has(event.id);
  const notification = lifecycle.find((candidate) => matchesLifecycle(candidate, event, index));
  const end = agent && !conflict ? observedEnd(agent.agentId, index) : undefined;
  const terminal = event.status === 'completed' || event.status === 'failed';
  const completedAt = notification?.at ?? (terminal ? event.acknowledgedAt : undefined);
  const status = notification?.status ?? (terminal ? event.status : undefined)
    ?? (event.acknowledgedAt !== undefined || end !== undefined ? 'incomplete' : 'unknown');
  return {
    ...event,
    ...(agent && !conflict && { agentId: agent.agentId, parentId: agent.parentId, depth: agent.depth, relationshipStatus: agent.relationshipStatus }),
    ...(conflict && { relationshipStatus: 'conflict', parentId: undefined }),
    ...(end !== undefined && { observedEnd: end }),
    ...(completedAt !== undefined && { completedAt }),
    status, elapsedMs: Math.max(0, (completedAt ?? end ?? event.start) - event.start),
  };
}

/** Apply consistent exact identities and protocol evidence from every owner transcript. */
export function normalizeClaudeTrace(events: DispatchEventRaw[], parsed: ParsedSession, index = buildClaudeTraceIndex(parsed)): DispatchEventRaw[] {
  const lifecycle = lifecycleEvents(index);
  return events.map((event) => normalizeEvent(event, index, lifecycle));
}
