import type { ParsedSession } from '../../../../agents/core/session/BaseSessionAdapter.js';
import type { DispatchEventRaw } from './types.js';

type LinkedTranscript = NonNullable<ParsedSession['subagents']>[number];
type RelationshipStatus = NonNullable<DispatchEventRaw['relationshipStatus']>;

interface NativeBlock {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  input?: { skill?: unknown; subagent_type?: unknown; name?: unknown };
  text?: unknown;
}

interface NativeRow {
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
  toolUseResult?: { isAsync?: boolean; status?: string; agentId?: string; taskId?: string };
  message?: { role?: string; content?: unknown };
}

export interface ClaudeTraceOwner {
  id: string;
  messages: unknown[];
  transcript?: LinkedTranscript;
}

export interface ClaudeTraceAgent {
  agentId: string;
  toolUseId?: string;
  ownerAgentId?: string;
  parentId?: string;
  depth?: number;
  relationshipStatus: RelationshipStatus;
  transcript: LinkedTranscript;
}

export interface ClaudeTraceIndex {
  rootOwnerId: string;
  owners: Map<string, ClaudeTraceOwner>;
  toolOwners: Map<string, string>;
  agents: Map<string, ClaudeTraceAgent>;
  childAgentsByOwner: Map<string, string[]>;
}

const timestampOf = (row: NativeRow): number | undefined => {
  const value = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  return Number.isFinite(value) ? value : undefined;
};

const blocksOf = (row: NativeRow): NativeBlock[] => Array.isArray(row.message?.content)
  ? row.message.content as NativeBlock[]
  : [];

const canonicalParent = (parentAgentId: string | undefined, rootOwnerId: string): string | undefined => {
  if (parentAgentId === 'root' || parentAgentId === rootOwnerId) return rootOwnerId;
  return parentAgentId;
};

/** Build exact transcript ownership and ancestry indexes shared by extraction and attribution. */
export function buildClaudeTraceIndex(parsed: ParsedSession): ClaudeTraceIndex {
  const rootOwnerId = parsed.sessionId;
  const owners = new Map<string, ClaudeTraceOwner>([[rootOwnerId, { id: rootOwnerId, messages: parsed.messages }]]);
  for (const transcript of parsed.subagents ?? []) {
    owners.set(transcript.agentId, { id: transcript.agentId, messages: transcript.messages, transcript });
  }

  const toolOwners = new Map<string, string>();
  for (const owner of owners.values()) {
    for (const row of owner.messages as NativeRow[]) {
      for (const block of blocksOf(row)) {
        if (block.type === 'tool_use' && typeof block.id === 'string' && !toolOwners.has(block.id)) {
          toolOwners.set(block.id, owner.id);
        }
      }
    }
  }

  const transcripts = new Map((parsed.subagents ?? []).map((item) => [item.agentId, item]));
  const cycleAgents = new Set<string>();
  for (const transcript of parsed.subagents ?? []) {
    const path = new Set<string>();
    let current: LinkedTranscript | undefined = transcript;
    while (current) {
      if (path.has(current.agentId)) {
        cycleAgents.add(transcript.agentId);
        break;
      }
      path.add(current.agentId);
      const parent = canonicalParent(current.parentAgentId, rootOwnerId);
      current = parent && parent !== rootOwnerId ? transcripts.get(parent) : undefined;
    }
  }

  const agents = new Map<string, ClaudeTraceAgent>();
  const childAgentsByOwner = new Map<string, string[]>();
  const linkedAgentByTool = new Map<string, string>();
  for (const transcript of parsed.subagents ?? []) {
    const expectedOwner = canonicalParent(transcript.parentAgentId, rootOwnerId);
    const actualOwner = transcript.toolUseId ? toolOwners.get(transcript.toolUseId) : undefined;
    let relationshipStatus: RelationshipStatus = 'missing';
    const duplicateLink = transcript.toolUseId ? linkedAgentByTool.has(transcript.toolUseId) : false;
    if (duplicateLink || (actualOwner && expectedOwner && actualOwner !== expectedOwner)) relationshipStatus = 'conflict';
    else if (actualOwner && (!expectedOwner || actualOwner === expectedOwner)) relationshipStatus = cycleAgents.has(transcript.agentId) ? 'cycle' : 'resolved';
    if (transcript.toolUseId && !duplicateLink) linkedAgentByTool.set(transcript.toolUseId, transcript.agentId);

    const ownerTranscript = actualOwner && actualOwner !== rootOwnerId ? transcripts.get(actualOwner) : undefined;
    const parentId = relationshipStatus === 'resolved' && ownerTranscript?.toolUseId ? ownerTranscript.toolUseId : undefined;
    agents.set(transcript.agentId, {
      agentId: transcript.agentId, toolUseId: transcript.toolUseId,
      ownerAgentId: relationshipStatus === 'resolved' ? actualOwner : undefined,
      parentId, depth: transcript.spawnDepth, relationshipStatus, transcript,
    });
    if (relationshipStatus === 'resolved' && actualOwner) {
      const children = childAgentsByOwner.get(actualOwner) ?? [];
      children.push(transcript.agentId);
      childAgentsByOwner.set(actualOwner, children);
    }
  }
  return { rootOwnerId, owners, toolOwners, agents, childAgentsByOwner };
}

interface LifecycleEvent { at: number; status: 'completed' | 'failed'; toolUseId?: string; taskId?: string }

const xmlValue = (text: string, name: string): string | undefined => {
  const match = new RegExp(`<${name}>([^<]+)</${name}>`).exec(text);
  return match?.[1]?.trim();
};

function lifecycleEvents(messages: unknown[]): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  const seen = new Set<string>();
  for (const row of messages as NativeRow[]) {
    const at = timestampOf(row);
    if (at === undefined) continue;
    let taskId: string | undefined;
    let toolUseId: string | undefined;
    let status: string | undefined;
    if (row.type === 'system' && row.subtype === 'task-notification') {
      taskId = row.taskId ?? row.task_id;
      toolUseId = row.toolUseId ?? row.tool_use_id;
      status = row.status;
    } else if (row.type === 'queue-operation' && (row.operation === 'enqueue' || row.operation === undefined)) {
      const content = typeof row.content === 'string' ? row.content : typeof row.message?.content === 'string' ? row.message.content : '';
      if (!content.trimStart().startsWith('<task-notification>')) continue;
      taskId = xmlValue(content, 'task-id');
      toolUseId = xmlValue(content, 'tool-use-id');
      status = xmlValue(content, 'status');
    } else continue;
    if (status !== 'completed' && status !== 'failed') continue;
    const key = toolUseId ?? taskId;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    events.push({ at, status, toolUseId, taskId });
  }
  return events;
}

const observedEnd = (agentId: string, index: ClaudeTraceIndex, visiting = new Set<string>()): number | undefined => {
  if (visiting.has(agentId)) return undefined;
  visiting.add(agentId);
  const owner = index.owners.get(agentId);
  let end: number | undefined;
  for (const row of (owner?.messages ?? []) as NativeRow[]) {
    const at = timestampOf(row);
    if (at !== undefined) end = Math.max(end ?? at, at);
  }
  for (const child of index.childAgentsByOwner.get(agentId) ?? []) {
    const childEnd = observedEnd(child, index, visiting);
    if (childEnd !== undefined) end = Math.max(end ?? childEnd, childEnd);
  }
  visiting.delete(agentId);
  return end;
};

/** Apply exact relationship and authoritative lifecycle evidence to extracted events. */
export function normalizeClaudeTrace(events: DispatchEventRaw[], parsed: ParsedSession, index = buildClaudeTraceIndex(parsed)): DispatchEventRaw[] {
  const lifecycle = lifecycleEvents(parsed.messages);
  return events.map((event) => {
    const agent = event.kind === 'agent' && event.id
      ? [...index.agents.values()].find((candidate) => candidate.toolUseId === event.id || candidate.agentId === event.agentId)
      : undefined;
    const notification = lifecycle.find((candidate) => candidate.toolUseId === event.id || (agent && candidate.taskId === agent.agentId));
    const end = agent ? observedEnd(agent.agentId, index) : undefined;
    const completedAt = notification?.at ?? (event.status === 'completed' ? event.acknowledgedAt : undefined);
    const status = notification?.status
      ?? (event.status === 'completed' || event.status === 'failed' ? event.status : undefined)
      ?? (agent && (event.acknowledgedAt !== undefined || end !== undefined) ? 'incomplete' : 'unknown');
    return {
      ...event,
      ...(agent && {
        agentId: agent.agentId,
        parentId: event.agentId && event.agentId !== agent.agentId ? undefined : agent.parentId,
        depth: agent.depth,
        relationshipStatus: event.agentId && event.agentId !== agent.agentId ? 'conflict' : agent.relationshipStatus,
      }),
      ...(end !== undefined && { observedEnd: end }),
      ...(completedAt !== undefined && { completedAt }),
      status,
      elapsedMs: Math.max(0, (completedAt ?? end ?? event.start) - event.start),
    };
  });
}
