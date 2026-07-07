/**
 * Conversation Sync Processor (Factory Pattern)
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

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '@/providers/plugins/sso/session/BaseProcessor.js';
import type { ParsedSession } from '@/providers/plugins/sso/session/BaseSessionAdapter.js';
import type { ConversationPayloadRecord } from './types.js';
import { CONVERSATION_SYNC_STATUS } from './types.js';
import { logger } from '@/utils/logger.js';
import { createApiClient as createConversationApiClient } from './apiClient.js';
import { getSessionConversationPath } from '@/agents/core/session/session-config.js';
import { readJSONL } from '../../utils/jsonl-reader.js';
import { writeJSONLAtomic } from '../../utils/jsonl-writer.js';
import {
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_RETRY_ATTEMPTS,
  CODEMIE_ASSISTANT_ID,
  DEFAULT_CONVERSATION_FOLDER,
  CONVERSATION_PROCESSOR_PRIORITY,
  CONVERSATION_PROCESSOR_NAME
} from './constants.js';

const MAX_CONVERSATION_SYNC_ATTEMPTS = 3;

/**
 * Create a conversation sync processor instance
 * @returns SessionProcessor instance
 */
export function createSyncProcessor(): SessionProcessor {
  // Private state (closure)
  let isSyncing = false; // Concurrency guard

  /**
   * Process conversations for sync
   */
  async function processConversations(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    if (process.env.CODEMIE_CONV_SYNC_DISABLED === '1') {
      logger.debug('[conv-sync] Conversation sync disabled for this session (CODEMIE_CONV_SYNC_DISABLED=1)');
      return { success: true, message: 'Conversation sync disabled for external session resume' };
    }
    if (isSyncing) {
      return { success: true, message: 'Sync in progress' };
    }
    isSyncing = true;

    try {
      // Read conversation payloads from JSONL
      const conversationsFile = getSessionConversationPath(session.sessionId);
      const allPayloads = await readJSONL<ConversationPayloadRecord>(conversationsFile);

      const pendingPayloads = allPayloads.filter(p =>
        p.status === CONVERSATION_SYNC_STATUS.PENDING ||
        (p.status === CONVERSATION_SYNC_STATUS.FAILED &&
          (p.syncAttempts ?? 0) < MAX_CONVERSATION_SYNC_ATTEMPTS)
      );

      if (pendingPayloads.length === 0) {
        logger.debug(`[${CONVERSATION_PROCESSOR_NAME}] No pending conversation payloads for session ${session.sessionId}`);
        return { success: true, message: 'No pending payloads' };
      }

      logger.info(`[${CONVERSATION_PROCESSOR_NAME}] Syncing ${pendingPayloads.length} conversation payload${pendingPayloads.length !== 1 ? 's' : ''}`);

      // Initialize API client
      const apiClient = createConversationApiClient({
        baseUrl: context.apiBaseUrl,
        cookies: context.cookies,
        apiKey: context.apiKey,
        timeout: DEFAULT_API_TIMEOUT_MS,
        retryAttempts: DEFAULT_RETRY_ATTEMPTS,
        version: context.version,
        clientType: context.clientType,
        dryRun: context.dryRun
      });

      // Send each pending payload to API
      let successCount = 0;
      let totalMessages = 0;
      const successfulPayloadIds = new Set<string>();
      const failedByPayloadId = new Map<string, string>();

      for (const pendingPayload of pendingPayloads) {
        const payloadId = getPayloadId(pendingPayload);
        const { conversationId, history, assistantId, folder, llmModel } = pendingPayload.payload;
        const resolvedAssistantId = assistantId || CODEMIE_ASSISTANT_ID;
        const resolvedFolder = folder || resolveConversationFolder(context.clientType, session.agentName);

        logger.debug(
          `[${CONVERSATION_PROCESSOR_NAME}] Sending payload: conversationId=${conversationId}, ` +
          `messages=${history.length}, folder=${resolvedFolder}, llmModel=${llmModel || 'unknown'}, ` +
          `isTurnContinuation=${pendingPayload.isTurnContinuation}`
        );

        try {

          // Send to API
          const response = await apiClient.upsertConversation(
            conversationId,
            history,
            resolvedAssistantId,
            resolvedFolder,
            llmModel
          );

          if (!response.success) {
            logger.error(`[${CONVERSATION_PROCESSOR_NAME}] Failed to sync conversation ${conversationId}: ${response.message}`);
            failedByPayloadId.set(payloadId, response.message);
            // Continue with other payloads even if one fails
            continue;
          }

          logger.info(`[${CONVERSATION_PROCESSOR_NAME}] Successfully synced conversation ${conversationId} (${response.new_messages} new, ${response.total_messages} total)`);
          successCount++;
          totalMessages += history.length;
          successfulPayloadIds.add(payloadId);

        } catch (error: any) {
          logger.error(`[${CONVERSATION_PROCESSOR_NAME}] Error syncing conversation ${conversationId}:`, error.message);
          failedByPayloadId.set(payloadId, error.message || 'Unknown error');
          // Continue with other payloads
        }
      }

      // Mark payloads as synced in JSONL (atomic rewrite)
      const syncedAt = Date.now();

      const updatedPayloads = allPayloads.map((p): ConversationPayloadRecord => {
        const payloadId = getPayloadId(p);
        if (successfulPayloadIds.has(payloadId)) {
          return {
            ...p,
            status: CONVERSATION_SYNC_STATUS.SUCCESS,
            syncAttempts: (p.syncAttempts ?? 0) + 1,
            error: undefined,
            response: {
              syncedCount: p.payload.history.length
            }
          };
        }

        const error = failedByPayloadId.get(payloadId);
        if (error) {
          return {
            ...p,
            status: CONVERSATION_SYNC_STATUS.FAILED,
            syncAttempts: (p.syncAttempts ?? 0) + 1,
            error,
          };
        }

        return p;
      });

      await writeJSONLAtomic(conversationsFile, updatedPayloads);

      logger.info(
        `[${CONVERSATION_PROCESSOR_NAME}] Successfully synced ${successCount}/${pendingPayloads.length} conversations (${totalMessages} messages)`
      );

      // Calculate sync updates for the adapter to persist
      let maxHistoryIndex = -1;
      let conversationId: string | undefined;
      let lastSyncedMessageUuid: string | undefined;

      if (successCount > 0) {
        let latestPayload: ConversationPayloadRecord | undefined;
        for (const payload of pendingPayloads) {
          if (!successfulPayloadIds.has(getPayloadId(payload))) continue;
          const historyIndices = payload.historyIndices || [];
          const payloadMaxIndex = historyIndices.length > 0
            ? Math.max(...historyIndices)
            : -1;
          const payloadRank = Math.max(
            payloadMaxIndex,
            parseSourceIndex(payload.lastProcessedMessageUuid)
          );
          const latestRank = latestPayload
            ? Math.max(
              latestPayload.historyIndices.length > 0 ? Math.max(...latestPayload.historyIndices) : -1,
              parseSourceIndex(latestPayload.lastProcessedMessageUuid)
            )
            : -1;

          if (!latestPayload || payloadRank > latestRank) {
            latestPayload = payload;
          }

          if (historyIndices.length > 0) {
            maxHistoryIndex = Math.max(maxHistoryIndex, payloadMaxIndex);
          }
        }

        if (latestPayload) {
          conversationId = latestPayload.payload.conversationId;
          lastSyncedMessageUuid = latestPayload.lastProcessedMessageUuid;
        }
      }

      // Debug: Log which payloads were marked as synced
      logger.debug(`[${CONVERSATION_PROCESSOR_NAME}] Marked payloads as synced:`, {
        syncedAt: new Date(syncedAt).toISOString(),
        payloadIds: Array.from(successfulPayloadIds),
        failedPayloadIds: Array.from(failedByPayloadId.keys()),
        totalPayloadsInFile: updatedPayloads.length,
        syncedCount: updatedPayloads.filter(p => p.status === CONVERSATION_SYNC_STATUS.SUCCESS).length,
        failedCount: updatedPayloads.filter(p => p.status === CONVERSATION_SYNC_STATUS.FAILED).length,
        pendingCount: updatedPayloads.filter(p => p.status === CONVERSATION_SYNC_STATUS.PENDING).length
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
              lastSyncedMessageUuid,
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
      logger.error(`[${CONVERSATION_PROCESSOR_NAME}] Processing failed:`, error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    } finally {
      isSyncing = false;
    }
  }

  // Public interface (SessionProcessor)
  return {
    name: CONVERSATION_PROCESSOR_NAME,
    priority: CONVERSATION_PROCESSOR_PRIORITY,
    shouldProcess(_session: ParsedSession): boolean {
      // Always try to process - will check for pending payloads inside
      return true;
    },
    async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
      return processConversations(session, context);
    }
  };
}

function resolveConversationFolder(clientType?: string, agentName?: string): string {
  if (clientType === 'codemie-codex' || agentName === 'codex') {
    return 'codex';
  }
  if (clientType === 'codemie-gemini' || agentName === 'gemini') {
    return 'gemini';
  }
  if (clientType === 'codemie-claude' || agentName === 'claude') {
    return 'claude';
  }
  return DEFAULT_CONVERSATION_FOLDER;
}

function getPayloadId(payload: ConversationPayloadRecord): string {
  return payload.payloadId ||
    payload.lastProcessedMessageUuid ||
    `${payload.payload.conversationId}:${payload.timestamp}`;
}

function parseSourceIndex(value: unknown): number {
  if (typeof value !== 'string') {
    return -1;
  }

  const index = Number.parseInt(value.slice(value.lastIndexOf('@') + 1), 10);
  return Number.isFinite(index) ? index : -1;
}
