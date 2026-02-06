/**
 * Session Syncer Service
 *
 * Syncs pending metrics and conversations from JSONL to API.
 * Used by both proxy timer and SessionEnd hook for consistent behavior.
 *
 * Prerequisites: Messages must already be transformed to JSONL by Claude processors
 *
 * Flow:
 * 1. Load session metadata
 * 2. Create empty ParsedSession (triggers Branch 2 in processors)
 * 3. Iterate through processors (same logic as plugin)
 * 4. Return aggregated results
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../agents/core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../agents/core/session/BaseSessionAdapter.js';
import { logger } from '../../../../utils/logger.js';
import { SessionStore } from '../../../../agents/core/session/SessionStore.js';
import { MetricsSyncProcessor } from './processors/metrics/metrics-sync-processor.js';
import { ConversationSyncProcessor } from './processors/conversations/conversation-sync-processor.js';

export interface SessionSyncResult {
  success: boolean;
  message: string;
  processorResults: Record<string, ProcessingResult>;
  failedProcessors: string[];
}

export class SessionSyncer {
  private sessionStore = new SessionStore();
  private processors: SessionProcessor[];

  constructor() {
    // Initialize processors (sorted by priority)
    this.processors = [
      new MetricsSyncProcessor(),
      new ConversationSyncProcessor()
    ].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Apply processor sync updates to session metadata.
   * Merges updates from all processors into session state.
   */
  private async applySyncUpdates(
    sessionId: string,
    results: ProcessingResult[]
  ): Promise<void> {
    try {
      const session = await this.sessionStore.loadSession(sessionId);

      if (!session) {
        logger.warn(`[SessionSyncer] Session not found for sync updates: ${sessionId}`);
        return;
      }

      for (const result of results) {
        if (!result.metadata?.syncUpdates) continue;

        const { syncUpdates } = result.metadata;

        // Apply metrics updates
        if (syncUpdates.metrics) {
          session.sync ??= {};
          session.sync.metrics ??= {
            lastProcessedTimestamp: Date.now(),
            processedRecordIds: [],
            totalDeltas: 0,
            totalSynced: 0,
            totalFailed: 0
          };

          // Merge processedRecordIds (deduplicate)
          if (syncUpdates.metrics.processedRecordIds) {
            const existing = new Set(session.sync.metrics.processedRecordIds || []);
            for (const id of syncUpdates.metrics.processedRecordIds) {
              existing.add(id);
            }
            session.sync.metrics.processedRecordIds = Array.from(existing);
          }

          // Update counters (increment, don't overwrite)
          if (syncUpdates.metrics.totalDeltas !== undefined) {
            session.sync.metrics.totalDeltas = syncUpdates.metrics.totalDeltas;
          }
          if (syncUpdates.metrics.totalSynced !== undefined) {
            session.sync.metrics.totalSynced = (session.sync.metrics.totalSynced || 0) + syncUpdates.metrics.totalSynced;
          }
          if (syncUpdates.metrics.totalFailed !== undefined) {
            session.sync.metrics.totalFailed = (session.sync.metrics.totalFailed || 0) + syncUpdates.metrics.totalFailed;
          }
          if (syncUpdates.metrics.lastProcessedTimestamp !== undefined) {
            session.sync.metrics.lastProcessedTimestamp = syncUpdates.metrics.lastProcessedTimestamp;
          }
        }

        // Apply conversations updates
        if (syncUpdates.conversations) {
          session.sync ??= {};
          session.sync.conversations ??= {
            lastSyncedMessageUuid: undefined,
            lastSyncedHistoryIndex: -1,
            totalMessagesSynced: 0,
            totalSyncAttempts: 0
          };

          // Update conversation tracking (latest wins)
          if (syncUpdates.conversations.lastSyncedMessageUuid !== undefined) {
            session.sync.conversations.lastSyncedMessageUuid =
              syncUpdates.conversations.lastSyncedMessageUuid;
          }
          if (syncUpdates.conversations.lastSyncedHistoryIndex !== undefined) {
            session.sync.conversations.lastSyncedHistoryIndex =
              Math.max(
                session.sync.conversations.lastSyncedHistoryIndex ?? -1,
                syncUpdates.conversations.lastSyncedHistoryIndex
              );
          }
          if (syncUpdates.conversations.conversationId !== undefined) {
            session.sync.conversations.conversationId = syncUpdates.conversations.conversationId;
          }
          if (syncUpdates.conversations.lastSyncAt !== undefined) {
            session.sync.conversations.lastSyncAt = syncUpdates.conversations.lastSyncAt;
          }

          // Update counters (increment, don't overwrite)
          if (syncUpdates.conversations.totalMessagesSynced !== undefined) {
            session.sync.conversations.totalMessagesSynced =
              (session.sync.conversations.totalMessagesSynced || 0) +
              syncUpdates.conversations.totalMessagesSynced;
          }
          if (syncUpdates.conversations.totalSyncAttempts !== undefined) {
            session.sync.conversations.totalSyncAttempts =
              (session.sync.conversations.totalSyncAttempts || 0) +
              syncUpdates.conversations.totalSyncAttempts;
          }
        }
      }

      // Persist session ONCE after all updates applied
      await this.sessionStore.saveSession(session);

      logger.debug(`[SessionSyncer] Session persisted after all processors completed`);
    } catch (error) {
      logger.error(`[SessionSyncer] Failed to apply sync updates:`, error);
      throw error;
    }
  }

  /**
   * Sync pending data to API
   * Iterates through processors (same logic as plugin)
   *
   * @param sessionId - CodeMie session ID
   * @param context - Processing context with API credentials
   * @returns Sync results
   */
  async sync(sessionId: string, context: ProcessingContext): Promise<SessionSyncResult> {
    logger.debug(`[SessionSyncer] Starting sync for session ${sessionId}`);

    try {
      // 1. Load session metadata
      const sessionMetadata = await this.sessionStore.loadSession(sessionId);

      if (!sessionMetadata) {
        return {
          success: false,
          message: 'Session not found',
          processorResults: {},
          failedProcessors: []
        };
      }

      if (!sessionMetadata.correlation || sessionMetadata.correlation.status !== 'matched') {
        return {
          success: false,
          message: `Session not correlated (status: ${sessionMetadata.correlation?.status || 'unknown'})`,
          processorResults: {},
          failedProcessors: []
        };
      }

      // 2. Create empty ParsedSession to force processors into "sync mode" (Branch 2)
      //    Empty messages array ensures processors read pending JSONL instead of transforming
      const emptySession: ParsedSession = {
        sessionId,
        agentName: sessionMetadata.agentName,
        metadata: {},
        messages: [],  // Empty = triggers Branch 2
        metrics: {
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          tools: {},
          toolStatus: {},
          fileOperations: []
        }
      };

      logger.debug(`[SessionSyncer] Processing session ${sessionId} with ${this.processors.length} processor${this.processors.length !== 1 ? 's' : ''}`);

      // 3. Iterate through processors and collect results
      const processorResults: Record<string, ProcessingResult> = {};
      const failedProcessors: string[] = [];
      const allResults: ProcessingResult[] = [];

      for (const processor of this.processors) {
        try {
          // Check if processor should run for this session
          if (!processor.shouldProcess(emptySession)) {
            logger.debug(`[SessionSyncer] Processor ${processor.name} skipped (shouldProcess=false)`);
            continue;
          }

          logger.debug(`[SessionSyncer] Running processor: ${processor.name} (priority ${processor.priority})`);

          // Process session
          const result = await processor.process(emptySession, context);
          processorResults[processor.name] = result;
          allResults.push(result);

          if (result.success) {
            logger.debug(`[SessionSyncer] Processor ${processor.name} succeeded: ${result.message || 'OK'}`);
          } else {
            logger.error(`[SessionSyncer] Processor ${processor.name} failed: ${result.message}`);
            failedProcessors.push(processor.name);
          }

        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[SessionSyncer] Processor ${processor.name} threw error:`, error);
          const failedResult: ProcessingResult = {
            success: false,
            message: errorMessage
          };
          processorResults[processor.name] = failedResult;
          allResults.push(failedResult);
          failedProcessors.push(processor.name);
        }
      }

      // 4. Apply all sync updates and persist session ONCE
      await this.applySyncUpdates(sessionId, allResults);

      // 5. Build result message
      // Extract detailed stats
      const parts: string[] = [];
      const metricsResult = processorResults['metrics-sync'];
      const conversationsResult = processorResults['conversation-sync'];

      if (metricsResult?.success && metricsResult.metadata?.deltasProcessed) {
        parts.push(`${metricsResult.metadata.deltasProcessed} metrics`);
      }
      if (conversationsResult?.success && conversationsResult.metadata?.payloadsSynced) {
        parts.push(`${conversationsResult.metadata.payloadsSynced} conversations`);
      }

      const totalCount = Object.keys(processorResults).length;
      const message = failedProcessors.length === 0
        ? parts.length > 0 ? `Synced ${parts.join(', ')}` : 'No pending data to sync'
        : `Sync completed with ${failedProcessors.length}/${totalCount} failures`;

      logger.info(`[SessionSyncer] ${message}`);

      return {
        success: failedProcessors.length === 0,
        message,
        processorResults,
        failedProcessors
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[SessionSyncer] Sync failed: ${errorMessage}`);
      return {
        success: false,
        message: errorMessage,
        processorResults: {},
        failedProcessors: []
      };
    }
  }
}
