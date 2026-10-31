import type { ParsedSession } from '../../../core/session/BaseSessionAdapter.js';
import type { ProcessingContext } from '../../../core/session/BaseProcessor.js';
import type { SessionStore } from '../../../core/session/SessionStore.js';
import { logger } from '../../../../utils/logger.js';
import type { MetricsProcessor } from './processors/claude.metrics-processor.js';
import type { Session } from '../../../core/session/types.js';
import type { ConversationsProcessor } from './processors/claude.conversations-processor.js';

export interface ClaudeBaselineOptions {
  sessionStore: SessionStore;
  metricsProcessor: MetricsProcessor;
  conversationsProcessor: ConversationsProcessor;
  parsedSession: ParsedSession;
  cutoffMs: number;
  context: ProcessingContext;
  caller: 'cli' | 'desktop';
  loadedSession?: Session;
}

/**
 * Marks transcript content written before `cutoffMs` as already processed: seeds the metrics
 * record ids and the conversation pointer, clears the marker, one save.
 */
export async function applyClaudeBaseline({
  sessionStore,
  metricsProcessor,
  conversationsProcessor,
  parsedSession,
  cutoffMs,
  context,
  caller,
  loadedSession
}: ClaudeBaselineOptions): Promise<void> {
  const session = loadedSession ?? await sessionStore.loadSession(parsedSession.sessionId);
  if (!session) {
    logger.warn(`[claude-baseline] Session not found for baseline, marker NOT cleared (next run retries): ${parsedSession.sessionId}`);
    return;
  }

  const pointer = await conversationsProcessor.computeBaselinePointer(
    parsedSession,
    cutoffMs,
    context.agentSessionFile
  );
  const processedRecordIds = metricsProcessor.computeBaselineRecordIds(
    parsedSession,
    session.sync?.metrics?.processedRecordIds ?? [],
    cutoffMs
  );

  session.sync ??= {};
  session.sync.metrics = {
    lastProcessedTimestamp: Date.now(),
    totalDeltas: 0,
    totalSynced: 0,
    totalFailed: 0,
    ...session.sync.metrics,
    processedRecordIds,
    baselineCutoffMs: cutoffMs
  };
  // Only forward: a retry after an earlier run synced past the cutoff keeps that run's pointer.
  const syncedHistoryIndex = session.sync.conversations?.lastSyncedHistoryIndex;
  if (
    pointer.lastSyncedMessageUuid &&
    (syncedHistoryIndex === undefined || syncedHistoryIndex < pointer.lastSyncedHistoryIndex)
  ) {
    session.sync.conversations = {
      totalMessagesSynced: 0,
      totalSyncAttempts: 0,
      ...session.sync.conversations,
      lastSyncedMessageUuid: pointer.lastSyncedMessageUuid,
      lastSyncedHistoryIndex: pointer.lastSyncedHistoryIndex
    };
  }
  if (session.runtimeCheckpoint) {
    delete session.runtimeCheckpoint.baselineCutoffMs;
  }

  // One write: the pointers and the cleared marker land together, so a crash either
  // replays the whole baseline or none of it.
  await sessionStore.saveSession(session);
  logger.info('[claude-baseline] Applied baseline', {
    sessionId: parsedSession.sessionId,
    caller,
    cutoff: new Date(cutoffMs).toISOString(),
    lastSyncedHistoryIndex: pointer.lastSyncedHistoryIndex,
    skippedMetricRecords: processedRecordIds.length
  });
}
