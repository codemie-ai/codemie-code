import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import type { DispatchEventRaw, SessionCost } from './types.js';
import type { UsageRecord } from './usage-readers.js';
import { buildClaudeTraceIndex, type ClaudeTraceIndex } from './claude-trace.js';
import { enrichSkillDispatchCost, priceAllocation } from './dispatch-allocation.js';

function recordsByOwner(records: UsageRecord[]): Map<string, UsageRecord[]> {
  const byOwner = new Map<string, UsageRecord[]>();
  for (const record of records) {
    if (record.ownerAgentId === undefined) continue;
    const owned = byOwner.get(record.ownerAgentId) ?? [];
    owned.push(record);
    byOwner.set(record.ownerAgentId, owned);
  }
  return byOwner;
}

function uncertainOwners(records: UsageRecord[], index: ClaudeTraceIndex): Set<string> {
  const owners = new Set<string>();
  for (const record of records) {
    if (record.ownerAgentId !== undefined || !record.key) continue;
    for (const candidate of index.responseCandidates.get(record.key) ?? []) owners.add(candidate);
  }
  return owners;
}

function allocateFamily(index: ClaudeTraceIndex, records: UsageRecord[], byOwner: Map<string, UsageRecord[]>, cost: SessionCost): void {
  const linked = subtreeOwners(index.rootOwnerId, index).owners;
  const root = priceAllocation(byOwner.get(index.rootOwnerId) ?? []);
  const unlinked = priceAllocation(records.filter((record) => !linked.has(record.ownerAgentId ?? '')));
  cost.rootOwnTokens = root.tokens;
  cost.rootOwnCostUSD = root.costUSD ?? 0;
  cost.unlinkedTokens = unlinked.tokens;
  cost.unlinkedCostUSD = unlinked.costUSD ?? 0;
  cost.unlinkedAgentIds = [...index.agents.keys()].filter((agentId) => !linked.has(agentId));
}

/** Ancestry comes only from the trace index; visited owners also guard malformed inferred cycles. */
function subtreeOwners(ownerId: string, index: ClaudeTraceIndex): { owners: Set<string>; cycle: boolean } {
  const owners = new Set<string>();
  const pending = [ownerId];
  let cycle = false;
  while (pending.length) {
    const current = pending.pop()!;
    if (owners.has(current)) {
      cycle = true;
      continue;
    }
    owners.add(current);
    for (const child of index.childAgentsByOwner.get(current) ?? []) pending.push(child);
  }
  return { owners, cycle };
}

/** Progressive rows and inherited tool calls count once for the canonical transcript owner. */
function claudeOwnerTools(ownerId: string, index: ClaudeTraceIndex): Array<{ name: string; calls: number }> {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const raw of (index.owners.get(ownerId)?.messages ?? []) as Array<{ message?: { content?: unknown } }>) {
    if (!Array.isArray(raw.message?.content)) continue;
    for (const block of raw.message.content as Array<{ type?: string; id?: string; name?: string }>) {
      if (block.type !== 'tool_use' || !block.name) continue;
      if (block.id) {
        if (seen.has(block.id) || index.toolOwners.get(block.id) !== ownerId) continue;
        seen.add(block.id);
      }
      counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
    }
  }
  return [...counts].map(([name, calls]) => ({ name, calls })).sort((left, right) => right.calls - left.calls).slice(0, 8);
}

/** Allocate session-owned responses without reparsing or claiming replayed usage a second time. */
export function enrichClaudeDispatchCosts(
  dispatches: DispatchEventRaw[], parsed: ParsedSession, records: UsageRecord[], cost: SessionCost,
): void {
  const index = buildClaudeTraceIndex(parsed);
  const byOwner = recordsByOwner(records);
  const uncertain = uncertainOwners(records, index);
  // SDK modelUsage rollups have no response ownership. Keep their totals authoritative,
  // but never manufacture zero-valued allocations that appear to reconcile those rollups.
  const ownsRecords = records.length > 0 || !cost.priced;
  if (ownsRecords) allocateFamily(index, records, byOwner, cost);
  for (const dispatch of dispatches) {
    dispatch.attributionStatus = 'unavailable';
    dispatch.attributionScope = dispatch.kind === 'agent' ? 'own' : 'owner-window';
    if (dispatch.relationshipStatus === 'conflict' || dispatch.relationshipStatus === 'cycle') {
      dispatch.attributionStatus = 'ambiguous';
      continue;
    }
    if (!ownsRecords) continue;
    if (dispatch.kind !== 'agent') {
      const owned = dispatch.ownerAgentId ? byOwner.get(dispatch.ownerAgentId) ?? [] : [];
      enrichSkillDispatchCost(dispatch, owned);
      if (dispatch.tokens) dispatch.attributionStatus = 'estimated';
      continue;
    }
    const agent = dispatch.agentId ? index.agents.get(dispatch.agentId) : undefined;
    if (!agent) continue;
    const subtree = subtreeOwners(agent.agentId, index);
    if (agent.relationshipStatus !== 'resolved' || dispatch.relationshipStatus !== 'resolved' || subtree.cycle || [...subtree.owners].some((owner) => uncertain.has(owner))) {
      dispatch.attributionStatus = 'ambiguous';
      continue;
    }
    Object.assign(dispatch, priceAllocation(byOwner.get(agent.agentId) ?? []));
    const inclusive = priceAllocation([...subtree.owners].flatMap((owner) => byOwner.get(owner) ?? []));
    dispatch.inclusiveTokens = inclusive.tokens;
    dispatch.inclusiveCostUSD = inclusive.costUSD;
    dispatch.attributionStatus = 'exact';
    const tools = claudeOwnerTools(agent.agentId, index);
    if (tools.length) dispatch.tools = tools;
  }
}
