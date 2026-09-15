import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import type { DispatchEventRaw } from './types.js';
import { claudeBlocks, type ClaudeAcknowledgement, type ClaudeNativeRow } from './claude-native.js';
import { buildClaudeOwnership, canonicalClaudeParent, type ClaudeOwnership } from './claude-ownership.js';
export { normalizeClaudeTrace } from './claude-lifecycle.js';

type LinkedTranscript = NonNullable<ParsedSession['subagents']>[number];
type RelationshipStatus = NonNullable<DispatchEventRaw['relationshipStatus']>;

/** Resolved or explicitly uncertain relationship between a child and its invoking owner. */
export interface ClaudeTraceAgent {
  agentId: string;
  toolUseId?: string;
  ownerAgentId?: string;
  parentId?: string;
  depth?: number;
  relationshipStatus: RelationshipStatus;
  transcript: LinkedTranscript;
}

/** Shared relationship indexes used for trace extraction and disjoint cost allocation. */
export interface ClaudeTraceIndex extends ClaudeOwnership {
  agents: Map<string, ClaudeTraceAgent>;
  childAgentsByOwner: Map<string, string[]>;
  agentsByTool: Map<string, string[]>;
  acknowledgements: Map<string, ClaudeAcknowledgement>;
  conflictingTools: Set<string>;
}

function cycleAgents(ownership: ClaudeOwnership): Set<string> {
  const cycles = new Set<string>();
  for (const owner of ownership.owners.values()) {
    const path = new Set<string>();
    let current: string | undefined = owner.id;
    while (current && current !== ownership.rootOwnerId) {
      if (path.has(current)) { cycles.add(owner.id); break; }
      path.add(current);
      current = ownership.parents.get(current);
    }
  }
  return cycles;
}

function transcriptClaims(index: ClaudeTraceIndex): void {
  for (const owner of index.owners.values()) {
    const tool = owner.transcript?.toolUseId;
    if (!tool) continue;
    const agents = index.agentsByTool.get(tool) ?? [];
    agents.push(owner.id);
    index.agentsByTool.set(tool, agents);
    if (agents.length > 1) index.conflictingTools.add(tool);
  }
}

function mergeAcknowledgement(tool: string, identity: ClaudeAcknowledgement, index: ClaudeTraceIndex): void {
  const existing = index.acknowledgements.get(tool) ?? {};
  for (const key of ['agentId', 'taskId'] as const) {
    if (existing[key] && identity[key] && existing[key] !== identity[key]) index.conflictingTools.add(tool);
  }
  index.acknowledgements.set(tool, { agentId: existing.agentId ?? identity.agentId, taskId: existing.taskId ?? identity.taskId });
  if (!identity.agentId) return;
  const metadataTool = index.owners.get(identity.agentId)?.transcript?.toolUseId;
  const claimants = index.agentsByTool.get(tool) ?? [];
  if ((metadataTool && metadataTool !== tool) || (claimants.length && !claimants.includes(identity.agentId))) {
    index.conflictingTools.add(tool);
    if (metadataTool) index.conflictingTools.add(metadataTool);
  }
}

function indexAcknowledgements(index: ClaudeTraceIndex): void {
  const identityTools = new Map<string, Set<string>>();
  for (const owner of index.owners.values()) {
    for (const row of owner.messages as ClaudeNativeRow[]) {
      if (!row?.toolUseResult) continue;
      for (const block of claudeBlocks(row)) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        mergeAcknowledgement(block.tool_use_id, row.toolUseResult, index);
        for (const identity of [row.toolUseResult.agentId, row.toolUseResult.taskId]) {
          if (!identity) continue;
          const tools = identityTools.get(identity) ?? new Set<string>();
          tools.add(block.tool_use_id);
          identityTools.set(identity, tools);
        }
      }
    }
  }
  for (const tools of identityTools.values()) {
    if (tools.size > 1) for (const tool of tools) index.conflictingTools.add(tool);
  }
}

function agentRelationship(transcript: LinkedTranscript, index: ClaudeTraceIndex, cycles: Set<string>): ClaudeTraceAgent {
  const expected = canonicalClaudeParent(transcript.parentAgentId, index.rootOwnerId);
  const actual = transcript.toolUseId ? index.toolOwners.get(transcript.toolUseId) : undefined;
  let relationshipStatus: RelationshipStatus = 'missing';
  if ((transcript.toolUseId && index.conflictingTools.has(transcript.toolUseId)) || (actual && expected && actual !== expected)) relationshipStatus = 'conflict';
  else if (cycles.has(transcript.agentId)) relationshipStatus = 'cycle';
  else if (actual) relationshipStatus = 'resolved';
  const parent = actual ? index.owners.get(actual)?.transcript : undefined;
  return {
    agentId: transcript.agentId, toolUseId: transcript.toolUseId,
    ownerAgentId: relationshipStatus === 'resolved' ? actual : undefined,
    parentId: relationshipStatus === 'resolved' ? parent?.toolUseId : undefined,
    depth: transcript.spawnDepth, relationshipStatus, transcript,
  };
}

function indexRelationships(index: ClaudeTraceIndex): void {
  const cycles = cycleAgents(index);
  for (const owner of index.owners.values()) {
    if (!owner.transcript) continue;
    const agent = agentRelationship(owner.transcript, index, cycles);
    index.agents.set(owner.id, agent);
    if (agent.relationshipStatus !== 'resolved' || !agent.ownerAgentId) continue;
    const children = index.childAgentsByOwner.get(agent.ownerAgentId) ?? [];
    children.push(agent.agentId);
    index.childAgentsByOwner.set(agent.ownerAgentId, children);
  }
}

/** Build exact ownership and relationship indexes without accepting first-discovered claimants. */
export function buildClaudeTraceIndex(parsed: ParsedSession): ClaudeTraceIndex {
  const index: ClaudeTraceIndex = {
    ...buildClaudeOwnership(parsed), agents: new Map(), childAgentsByOwner: new Map(),
    agentsByTool: new Map(), acknowledgements: new Map(), conflictingTools: new Set(),
  };
  for (const tool of index.unresolvedTools) index.conflictingTools.add(tool);
  transcriptClaims(index);
  indexAcknowledgements(index);
  indexRelationships(index);
  return index;
}
