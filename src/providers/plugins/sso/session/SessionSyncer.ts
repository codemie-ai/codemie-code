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

      // 3. Iterate through processors (same as plugin logic)
      const processorResults: Record<string, ProcessingResult> = {};
      const failedProcessors: string[] = [];

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

          if (result.success) {
            logger.debug(`[SessionSyncer] Processor ${processor.name} succeeded: ${result.message || 'OK'}`);
          } else {
            logger.error(`[SessionSyncer] Processor ${processor.name} failed: ${result.message}`);
            failedProcessors.push(processor.name);
          }

        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[SessionSyncer] Processor ${processor.name} threw error:`, error);
          processorResults[processor.name] = {
            success: false,
            message: errorMessage
          };
          failedProcessors.push(processor.name);
        }
      }

      // 4. Build result message
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
