import type { ProcessingResult } from './BaseProcessor.js';
import type { Session } from './types.js';

/**
 * Merge processor sync updates into a session.
 *
 * Processor counters are per-run deltas, not lifetime totals.
 *
 * @returns true when the session was changed and should be persisted.
 */
export function applyProcessingSyncUpdates(
  session: Session,
  results: ProcessingResult[]
): boolean {
  let hasChanges = false;

  for (const result of results) {
    if (!result.metadata?.syncUpdates) continue;

    const { syncUpdates } = result.metadata;

    if (syncUpdates.metrics) {
      session.sync ??= {};
      session.sync.metrics ??= {
        lastProcessedTimestamp: Date.now(),
        processedRecordIds: [],
        totalDeltas: 0,
        totalSynced: 0,
        totalFailed: 0,
      };

      if (syncUpdates.metrics.processedRecordIds) {
        const existing = new Set(session.sync.metrics.processedRecordIds || []);
        const beforeSize = existing.size;
        for (const id of syncUpdates.metrics.processedRecordIds) {
          existing.add(id);
        }
        if (existing.size !== beforeSize) {
          session.sync.metrics.processedRecordIds = Array.from(existing);
          hasChanges = true;
        }
      }

      if (syncUpdates.metrics.totalDeltas !== undefined) {
        session.sync.metrics.totalDeltas = (session.sync.metrics.totalDeltas || 0) + syncUpdates.metrics.totalDeltas;
        hasChanges = true;
      }
      if (syncUpdates.metrics.totalSynced !== undefined) {
        session.sync.metrics.totalSynced = (session.sync.metrics.totalSynced || 0) + syncUpdates.metrics.totalSynced;
        hasChanges = true;
      }
      if (syncUpdates.metrics.totalFailed !== undefined) {
        session.sync.metrics.totalFailed = (session.sync.metrics.totalFailed || 0) + syncUpdates.metrics.totalFailed;
        hasChanges = true;
      }
      if (
        syncUpdates.metrics.lastProcessedTimestamp !== undefined &&
        session.sync.metrics.lastProcessedTimestamp !== syncUpdates.metrics.lastProcessedTimestamp
      ) {
        session.sync.metrics.lastProcessedTimestamp = syncUpdates.metrics.lastProcessedTimestamp;
        hasChanges = true;
      }
    }

    if (syncUpdates.conversations) {
      session.sync ??= {};
      session.sync.conversations ??= {
        lastSyncedMessageUuid: undefined,
        lastSyncedHistoryIndex: -1,
        totalMessagesSynced: 0,
        totalSyncAttempts: 0,
      };

      if (
        syncUpdates.conversations.lastSyncedMessageUuid !== undefined &&
        session.sync.conversations.lastSyncedMessageUuid !== syncUpdates.conversations.lastSyncedMessageUuid
      ) {
        session.sync.conversations.lastSyncedMessageUuid =
          syncUpdates.conversations.lastSyncedMessageUuid;
        hasChanges = true;
      }
      if (syncUpdates.conversations.lastSyncedHistoryIndex !== undefined) {
        const nextHistoryIndex = Math.max(
          session.sync.conversations.lastSyncedHistoryIndex ?? -1,
          syncUpdates.conversations.lastSyncedHistoryIndex
        );
        if (session.sync.conversations.lastSyncedHistoryIndex !== nextHistoryIndex) {
          session.sync.conversations.lastSyncedHistoryIndex = nextHistoryIndex;
          hasChanges = true;
        }
      }
      if (
        syncUpdates.conversations.conversationId !== undefined &&
        session.sync.conversations.conversationId !== syncUpdates.conversations.conversationId
      ) {
        session.sync.conversations.conversationId = syncUpdates.conversations.conversationId;
        hasChanges = true;
      }
      if (
        syncUpdates.conversations.lastSyncAt !== undefined &&
        session.sync.conversations.lastSyncAt !== syncUpdates.conversations.lastSyncAt
      ) {
        session.sync.conversations.lastSyncAt = syncUpdates.conversations.lastSyncAt;
        hasChanges = true;
      }
      if (syncUpdates.conversations.totalMessagesSynced !== undefined) {
        session.sync.conversations.totalMessagesSynced =
          (session.sync.conversations.totalMessagesSynced || 0) +
          syncUpdates.conversations.totalMessagesSynced;
        hasChanges = true;
      }
      if (syncUpdates.conversations.totalSyncAttempts !== undefined) {
        session.sync.conversations.totalSyncAttempts =
          (session.sync.conversations.totalSyncAttempts || 0) +
          syncUpdates.conversations.totalSyncAttempts;
        hasChanges = true;
      }
    }
  }

  return hasChanges;
}
