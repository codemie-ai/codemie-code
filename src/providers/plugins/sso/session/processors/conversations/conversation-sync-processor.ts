/**
 * Conversation Sync Processor (SSO Provider)
 *
 * Lightweight processor that syncs conversation payloads to CodeMie API.
 *
 * Responsibilities:
 * - Read pending conversation payloads from JSONL (written by agent adapters)
 * - Send payloads to CodeMie API
 * - Mark payloads as 'success' or 'failed' atomically
 *
 * Note: Message transformation is handled by agent adapters (e.g., Claude's ConversationsProcessor)
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../BaseProcessor.js';
import type { ParsedSession } from '../../BaseSessionAdapter.js';
import { logger } from '../../../../../../utils/logger.js';
import { ConversationApiClient } from './conversation-api-client.js';
import type { ConversationPayloadRecord } from './conversation-types.js';
import { getSessionConversationPath } from '../../../../../../agents/core/session/session-config.js';
import { readJSONL } from '../../utils/jsonl-reader.js';
import { writeJSONLAtomic } from '../../utils/jsonl-writer.js';

export class ConversationSyncProcessor implements SessionProcessor {
  readonly name = 'conversation-sync';
  readonly priority = 2; // Run after metrics (priority 1)

  private isSyncing = false; // Concurrency guard

  shouldProcess(_session: ParsedSession): boolean {
    // Always try to process - will check for pending payloads inside
    return true;
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    if (this.isSyncing) {
      return { success: true, message: 'Sync in progress' };
    }
    this.isSyncing = true;

    try {
      // Read conversation payloads from JSONL
      const conversationsFile = getSessionConversationPath(session.sessionId);
      const allPayloads = await readJSONL<ConversationPayloadRecord>(conversationsFile);

      const pendingPayloads = allPayloads.filter(p => p.status === 'pending');

      if (pendingPayloads.length === 0) {
        logger.debug(`[${this.name}] No pending conversation payloads for session ${session.sessionId}`);
        return { success: true, message: 'No pending payloads' };
      }

      logger.info(`[${this.name}] Syncing ${pendingPayloads.length} conversation payload${pendingPayloads.length !== 1 ? 's' : ''}`);

      // Initialize API client
      const apiClient = new ConversationApiClient({
        baseUrl: context.apiBaseUrl,
        cookies: context.cookies,
        apiKey: context.apiKey,
        timeout: 30000,
        retryAttempts: 3,
        version: context.version,
        clientType: context.clientType,
        dryRun: context.dryRun
      });

      // Send each pending payload to API
      let successCount = 0;
      let totalMessages = 0;

      for (const pendingPayload of pendingPayloads) {
        const { conversationId, history } = pendingPayload.payload;

        logger.debug(
          `[${this.name}] Sending payload: conversationId=${conversationId}, ` +
          `messages=${history.length}, isTurnContinuation=${pendingPayload.isTurnContinuation}`
        );

        try {

          // Send to API
          const response = await apiClient.upsertConversation(
            conversationId,
            history,
            '5a430368-9e91-4564-be20-989803bf4da2', // Assistant ID
            session.agentName // Agent display name (e.g., "Claude Code")
          );

          if (!response.success) {
            logger.error(`[${this.name}] Failed to sync conversation ${conversationId}: ${response.message}`);
            // Continue with other payloads even if one fails
            continue;
          }

          logger.info(`[${this.name}] Successfully synced conversation ${conversationId} (${response.new_messages} new, ${response.total_messages} total)`);
          successCount++;
          totalMessages += history.length;

        } catch (error: any) {
          logger.error(`[${this.name}] Error syncing conversation ${conversationId}:`, error.message);
          // Continue with other payloads
        }
      }

      // Mark payloads as synced in JSONL (atomic rewrite)
      const syncedAt = Date.now();
      const pendingTimestamps = new Set(pendingPayloads.map(p => p.timestamp));

      const updatedPayloads = allPayloads.map((p): ConversationPayloadRecord =>
        pendingTimestamps.has(p.timestamp)
          ? {
              ...p,
              status: 'success' as const,
              response: {
                syncedCount: p.payload.history.length
              }
            }
          : p
      );

      await writeJSONLAtomic(conversationsFile, updatedPayloads);

      logger.info(
        `[${this.name}] Successfully synced ${successCount}/${pendingPayloads.length} conversations (${totalMessages} messages)`
      );

      // Calculate sync updates for the adapter to persist
      let maxHistoryIndex = -1;
      let conversationId: string | undefined;

      if (successCount > 0) {
        // Find the highest history index from successfully synced payloads
        for (const payload of pendingPayloads) {
          const historyIndices = payload.historyIndices || [];
          if (historyIndices.length > 0) {
            const payloadMaxIndex = Math.max(...historyIndices);
            maxHistoryIndex = Math.max(maxHistoryIndex, payloadMaxIndex);
          }
        }

        // Get conversation ID from first payload
        if (pendingPayloads.length > 0) {
          conversationId = pendingPayloads[0].payload.conversationId;
        }
      }

      // Debug: Log which payloads were marked as synced
      logger.debug(`[${this.name}] Marked payloads as synced:`, {
        syncedAt: new Date(syncedAt).toISOString(),
        timestamps: Array.from(pendingTimestamps),
        totalPayloadsInFile: updatedPayloads.length,
        syncedCount: updatedPayloads.filter(p => p.status === 'success').length,
        pendingCount: updatedPayloads.filter(p => p.status === 'pending').length
      });

      return {
        success: true,
        message: `Synced ${successCount}/${pendingPayloads.length} conversations`,
        metadata: {
          conversationId: session.sessionId,
          messagesProcessed: totalMessages,
          payloadsSynced: successCount,
          syncUpdates: successCount > 0 ? {
            conversations: {
              lastSyncedHistoryIndex: maxHistoryIndex,
              conversationId,
              totalMessagesSynced: totalMessages,
              totalSyncAttempts: 1,
              lastSyncAt: syncedAt
            }
          } : undefined
        }
      };

    } catch (error) {
      logger.error(`[${this.name}] Processing failed:`, error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    } finally {
      this.isSyncing = false;
    }
  }
}
