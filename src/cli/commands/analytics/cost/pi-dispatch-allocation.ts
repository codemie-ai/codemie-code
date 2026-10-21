import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import type { DispatchEventRaw, SessionCost } from './types.js';
import type { UsageRecord } from './usage-readers.js';
import { priceAllocation } from './dispatch-allocation.js';

/**
 * Split a Pi / omp session's accepted usage into the root's own spend and spend no dispatch
 * accounts for. A child owner id is a transcript path (`A` or `A/A.B`); it is linked when its
 * first segment is the task id of a dispatched agent, so nested children roll up under the
 * top-level dispatch that spawned them.
 */
export function allocatePiUsage(
  dispatches: DispatchEventRaw[],
  parsed: ParsedSession,
  records: UsageRecord[],
  cost: SessionCost
): void {
  const linked = new Set<string>();
  for (const dispatch of dispatches) {
    if (dispatch.kind === 'agent' && dispatch._taskId) linked.add(dispatch._taskId);
  }
  const isLinked = (owner: string): boolean => linked.has(owner.split('/')[0]);

  const root = priceAllocation(records.filter((record) => record.ownerAgentId === parsed.sessionId));
  const unlinkedRecords = records.filter(
    (record) =>
      record.ownerAgentId !== undefined && record.ownerAgentId !== parsed.sessionId && !isLinked(record.ownerAgentId)
  );
  const unlinked = priceAllocation(unlinkedRecords);

  cost.rootOwnTokens = root.tokens;
  cost.rootOwnCostUSD = root.costUSD ?? 0;
  cost.unlinkedTokens = unlinked.tokens;
  cost.unlinkedCostUSD = unlinked.costUSD ?? 0;
  cost.unlinkedAgentIds = [...new Set(unlinkedRecords.map((record) => record.ownerAgentId as string))].sort();
}
