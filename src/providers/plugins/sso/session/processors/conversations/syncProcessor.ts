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
import { shouldStopSync } from '@/agents/core/session/BaseProcessor.js';
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
      let deferred = false;
      const successfulPayloadIds = new Set<string>();
      const failedByPayloadId = new Map<string, string>();

      for (const pendingPayload of pendingPayloads) {
        // Stop BEFORE sending the next payload when the caller's sync deadline
        // expired or an abort was signaled (the SessionEnd hook can be killed at
        // any moment; leftovers stay pending for the next run).
        if (shouldStopSync(context)) {
          deferred = true;
          break;
        }

        const payloadId = getPayloadId(pendingPayload);
        const { conversationId, history, assistantId, folder, llmModel } = pendingPayload.payload;
        const resolvedAssistantId = assistantId || CODEMIE_ASSISTANT_ID;
        const resolvedFolder = folder || resolveConversationFolder(context.clientType, session.agentName);

        logger.debug(
          `[${CONVERSATION_PROCESSOR_NAME}] Sending payload: conversationId=${conversationId}, ` +
          `messages=${history.length}, folder=${resolvedFolder}, llmModel=${llmModel || 'unknown'}, ` +
          `isTurnContinuation=${pendingPayload.isTurnContinuation}`
        );

        let syncError: string | undefined;
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
            syncError = response.message;
          } else {
            logger.info(`[${CONVERSATION_PROCESSOR_NAME}] Successfully synced conversation ${conversationId} (${response.new_messages} new, ${response.total_messages} total)`);
            successCount++;
            totalMessages += history.length;
            successfulPayloadIds.add(payloadId);
          }

        } catch (error: any) {
          logger.error(`[${CONVERSATION_PROCESSOR_NAME}] Error syncing conversation ${conversationId}:`, error.message);
          syncError = error.message || 'Unknown error';
        }

        if (syncError) {
          failedByPayloadId.set(payloadId, syncError);
        }

        // Persist THIS payload's outcome immediately (atomic full-file rewrite).
        // A kill mid-loop must never lose progress made so far.
        applyPayloadOutcome(allPayloads, payloadId, syncError);
        try {
          await writeJSONLAtomic(conversationsFile, allPayloads);
        } catch (writeError) {
          // Keep going: in-memory state is ahead of disk, a later iteration may persist it
          logger.error(`[${CONVERSATION_PROCESSOR_NAME}] Failed to persist payload outcome:`, writeError);
        }
      }

      const syncedAt = Date.now();
      const attemptedCount = successfulPayloadIds.size + failedByPayloadId.size;
      const remainingCount = pendingPayloads.length - attemptedCount;

      const message = deferred
        ? `Sync deferred: ${remainingCount} items remaining (deadline/abort)`
        : `Synced ${successCount}/${pendingPayloads.length} conversations`;

      if (deferred) {
        logger.info(`[${CONVERSATION_PROCESSOR_NAME}] ${message} (${successCount} synced before stop)`);
      } else {
        logger.info(
          `[${CONVERSATION_PROCESSOR_NAME}] Successfully synced ${successCount}/${pendingPayloads.length} conversations (${totalMessages} messages)`
        );
      }

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
        totalPayloadsInFile: allPayloads.length,
        syncedCount: allPayloads.filter(p => p.status === CONVERSATION_SYNC_STATUS.SUCCESS).length,
        failedCount: allPayloads.filter(p => p.status === CONVERSATION_SYNC_STATUS.FAILED).length,
        pendingCount: allPayloads.filter(p => p.status === CONVERSATION_SYNC_STATUS.PENDING).length
      });

      return {
        success: true,
        message,
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
  if (clientType === 'codemie-copilot' || agentName === 'copilot-cli') {
    return 'copilot-cli';
  }
  if (clientType === 'codemie-gemini' || agentName === 'gemini') {
    return 'gemini';
  }
  if (clientType === 'codemie-claude' || agentName === 'claude') {
    return 'claude';
  }
  if (clientType === 'codemie-opencode' || agentName === 'opencode') {
    return 'opencode';
  }
  if (clientType === 'codemie-pi' || agentName === 'pi') {
    return 'pi';
  }
  return DEFAULT_CONVERSATION_FOLDER;
}

function getPayloadId(payload: ConversationPayloadRecord): string {
  return payload.payloadId ||
    payload.lastProcessedMessageUuid ||
    `${payload.payload.conversationId}:${payload.timestamp}`;
}

/**
 * Apply a single payload's sync outcome to the in-memory records (in place).
 * Mirrors the per-payload success/failure mapping so the file can be rewritten
 * after every payload instead of only at the end of the loop.
 */
function applyPayloadOutcome(
  allPayloads: ConversationPayloadRecord[],
  payloadId: string,
  syncError: string | undefined
): void {
  const index = allPayloads.findIndex(p => getPayloadId(p) === payloadId);
  if (index === -1) {
    return;
  }

  const p = allPayloads[index];
  allPayloads[index] = syncError
    ? {
      ...p,
      status: CONVERSATION_SYNC_STATUS.FAILED,
      syncAttempts: (p.syncAttempts ?? 0) + 1,
      error: syncError,
    }
    : {
      ...p,
      status: CONVERSATION_SYNC_STATUS.SUCCESS,
      syncAttempts: (p.syncAttempts ?? 0) + 1,
      error: undefined,
      response: {
        syncedCount: p.payload.history.length
      }
    };
}

function parseSourceIndex(value: unknown): number {
  if (typeof value !== 'string') {
    return -1;
  }

  const index = Number.parseInt(value.slice(value.lastIndexOf('@') + 1), 10);
  return Number.isFinite(index) ? index : -1;
}
