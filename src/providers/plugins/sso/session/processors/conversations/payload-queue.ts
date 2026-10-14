/**
 * Conversation Payload Queue Helpers
 *
 * Pure, in-place helpers over the records read from `{sessionId}_conversation.jsonl`.
 * The sync processor runs them before sending: heal → collapse → cap → send.
 */

import type { ConversationPayloadRecord } from './types.js';
import { CONVERSATION_SYNC_STATUS } from './types.js';

/** A failed record is retried until it has been attempted this many times */
export const MAX_CONVERSATION_SYNC_ATTEMPTS = 3;

/**
 * Identifier shared by every record queued for the same payload window.
 * Records without a payloadId fall back to the last processed message UUID,
 * then to `conversationId:timestamp`.
 */
export function getPayloadId(payload: ConversationPayloadRecord): string {
  return payload.payloadId ||
    payload.lastProcessedMessageUuid ||
    `${payload.payload.conversationId}:${payload.timestamp}`;
}

/**
 * Whether a record may still be sent: pending, or failed with retries left.
 */
export function isSendCandidate(payload: ConversationPayloadRecord): boolean {
  return payload.status === CONVERSATION_SYNC_STATUS.PENDING ||
    (payload.status === CONVERSATION_SYNC_STATUS.FAILED &&
      (payload.syncAttempts ?? 0) < MAX_CONVERSATION_SYNC_ATTEMPTS);
}

/**
 * Mark every send candidate whose payloadId already has a `success` record as
 * `success`, without sending it and without counting a sync attempt.
 *
 * @returns the number of records healed
 */
export function healSyncedDuplicates(allPayloads: ConversationPayloadRecord[]): number {
  const syncedIds = new Set(
    allPayloads
      .filter(p => p.status === CONVERSATION_SYNC_STATUS.SUCCESS)
      .map(getPayloadId)
  );
  if (syncedIds.size === 0) {
    return 0;
  }

  let healed = 0;
  allPayloads.forEach((p, index) => {
    if (!isSendCandidate(p) || !syncedIds.has(getPayloadId(p))) {
      return;
    }
    allPayloads[index] = {
      ...p,
      status: CONVERSATION_SYNC_STATUS.SUCCESS,
      error: undefined,
    };
    healed++;
  });
  return healed;
}

/**
 * Keys `${conversationId}|${history_index}|${role}` of a record's history entries,
 * or undefined when the record is ineligible for collapse: an empty history, or an
 * entry without a numeric `history_index` and a string `role` (e.g. codex sentinels).
 */
function getCollapseKeys(record: ConversationPayloadRecord): string[] | undefined {
  const history: unknown[] = record.payload.history ?? [];
  if (history.length === 0) {
    return undefined;
  }

  const keys: string[] = [];
  for (const entry of history) {
    const { history_index: historyIndex, role } = (entry ?? {}) as { history_index?: unknown; role?: unknown };
    if (typeof historyIndex !== 'number' || typeof role !== 'string') {
      return undefined;
    }
    keys.push(`${record.payload.conversationId}|${historyIndex}|${role}`);
  }
  return keys;
}

/**
 * Mark send candidates whose every history entry is re-sent by a newer eligible
 * candidate as `superseded` (in place). "Newer" means a later position in the
 * queue file; a partly covered record is left to be sent whole.
 *
 * @param candidates send candidates in queue-file order
 * @returns the number of records superseded
 */
export function collapseSupersededPayloads(candidates: ConversationPayloadRecord[]): number {
  const newerKeys = new Set<string>();
  let superseded = 0;

  for (let index = candidates.length - 1; index >= 0; index--) {
    const keys = getCollapseKeys(candidates[index]);
    if (!keys) {
      continue;
    }

    if (keys.every(key => newerKeys.has(key))) {
      candidates[index].status = CONVERSATION_SYNC_STATUS.SUPERSEDED;
      superseded++;
    } else {
      for (const key of keys) {
        newerKeys.add(key);
      }
    }
  }
  return superseded;
}
