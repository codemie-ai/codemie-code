/**
 * Conversations Processor (Simplified - Refactored)
 *
 * Processes parsed session data to sync conversations to CodeMie API with incremental tracking.
 *
 * Key Improvements:
 * - Removed complex turn detection logic
 * - Delegates all logic to stateless transformer
 * - Simply loads state, calls transformer, saves state
 * - Transformer handles turn continuation detection, message filtering, etc.
 *
 * Responsibilities:
 * - Load sync state from SessionStore
 * - Call agent's transformer with ALL messages + sync state
 * - Send transformed history to API
 * - Update sync state with transformer result
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../base/BaseProcessor.js';
import type { ParsedSession } from '../../adapters/base/BaseSessionAdapter.js';
import { logger } from '../../../../../../utils/logger.js';
import { ConversationApiClient } from './conversation-api-client.js';
import { ConversationPayloadWriter } from './ConversationPayloadWriter.js';

export class ConversationsProcessor implements SessionProcessor {
  readonly name = 'conversations';
  readonly priority = 2; // Run after metrics (priority 1)

  private isSyncing = false; // Concurrency guard

  shouldProcess(session: ParsedSession): boolean {
    // Process if session has messages
    return session.messages && session.messages.length > 0;
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    // Concurrency guard
    if (this.isSyncing) {
      return { success: true, message: 'Sync in progress' };
    }
    this.isSyncing = true;

    try {
      const messages = session.messages;

      // Check for messages
      if (messages.length === 0) {
        logger.debug(`[${this.name}] No messages in session ${session.sessionId}`);
        return { success: true, message: 'No messages to process' };
      }

      // Load session metadata
      const { SessionStore } = await import('../../../../../../agents/core/session/SessionStore.js');
      const sessionStore = new SessionStore();
      const sessionMetadata = await sessionStore.loadSession(session.sessionId);

      if (!sessionMetadata) {
        logger.debug(`[${this.name}] Session metadata not found for ${session.sessionId}`);
        return { success: false, message: 'Session metadata not found' };
      }

      // Get agent from registry
      const { AgentRegistry } = await import('../../../../../../agents/registry.js');
      const agent = AgentRegistry.getAgent(session.agentName);

      if (!agent) {
        logger.error(`[${this.name}] Agent not found in registry: ${session.agentName}`);
        return { success: false, message: `Agent not found: ${session.agentName}` };
      }

      const agentDisplayName = (agent as any)?.metadata?.displayName || agent.name;

      // Get conversations adapter
      const conversationsAdapter = (agent as any).getConversationsAdapter?.();

      if (!conversationsAdapter) {
        logger.warn(`[${this.name}] No conversations adapter available for agent: ${session.agentName}`);
        return { success: true, message: 'Conversations sync not supported for this agent' };
      }

      // Get or initialize sync state
      const syncState = sessionMetadata.sync?.conversations || {
        lastSyncedMessageUuid: undefined,
        lastSyncedHistoryIndex: -1  // Will become 0 for first turn
      };

      const conversationId = syncState.conversationId || session.sessionId;

      // ============================================================
      // ✅ SIMPLIFIED: Let transformer do all the work!
      // ============================================================
      const result = conversationsAdapter.transformMessages(
        messages,  // Pass ALL messages
        syncState, // Pass sync state
        '5a430368-9e91-4564-be20-989803bf4da2',  // Assistant ID
        agentDisplayName
      );

      // No new history - return early
      if (result.history.length === 0) {
        logger.debug(`[${this.name}] No new history for session ${session.sessionId}`);

        // Still update UUID if transformer advanced it
        if (result.lastProcessedMessageUuid !== syncState.lastSyncedMessageUuid) {
          if (!sessionMetadata.sync) sessionMetadata.sync = {};
          if (!sessionMetadata.sync.conversations) {
            sessionMetadata.sync.conversations = {
              conversationId: session.sessionId,
              lastSyncedMessageUuid: result.lastProcessedMessageUuid,
              lastSyncedHistoryIndex: result.currentHistoryIndex,
              lastSyncAt: Date.now(),
              totalMessagesSynced: 0,
              totalSyncAttempts: 1
            };
          } else {
            sessionMetadata.sync.conversations.lastSyncedMessageUuid = result.lastProcessedMessageUuid;
          }
          await sessionStore.saveSession(sessionMetadata);
        }

        return { success: true, message: 'No new messages to sync' };
      }

      logger.info(
        `[${this.name}] Syncing conversation ${conversationId}: ` +
        `${result.isTurnContinuation ? 'continuation' : 'new turn'} ` +
        `with ${result.history.length} entries at history_index ${result.currentHistoryIndex}`
      );

      // Initialize payload writer for debugging
      const payloadWriter = new ConversationPayloadWriter(session.sessionId);

      // Write payload BEFORE API call
      await payloadWriter.appendPayload(
        {
          conversationId,
          history: result.history
        },
        {
          isTurnContinuation: result.isTurnContinuation,
          historyIndices: result.history.map(entry => entry.history_index)
        }
      );

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

      // Send to API
      const response = await apiClient.upsertConversation(
        conversationId,
        result.history,
        '5a430368-9e91-4564-be20-989803bf4da2',
        agentDisplayName
      );

      if (!response.success) {
        await payloadWriter.updateLastPayloadStatus('failed', response.message);
        logger.error(`[${this.name}] Failed to sync conversation ${conversationId}: ${response.message}`);
        return { success: false, message: `Failed to sync conversation: ${response.message}` };
      }

      await payloadWriter.updateLastPayloadStatus('success', undefined, {
        syncedCount: result.history.length
      });

      // ============================================================
      // ✅ SIMPLIFIED: Just save the state from transformer
      // ============================================================
      if (!sessionMetadata.sync) {
        sessionMetadata.sync = {};
      }

      if (!sessionMetadata.sync.conversations) {
        sessionMetadata.sync.conversations = {
          conversationId: session.sessionId,
          lastSyncedMessageUuid: result.lastProcessedMessageUuid,
          lastSyncedHistoryIndex: result.currentHistoryIndex,
          lastSyncAt: Date.now(),
          totalMessagesSynced: result.history.length,
          totalSyncAttempts: 1
        };
      } else {
        sessionMetadata.sync.conversations.conversationId = session.sessionId;
        sessionMetadata.sync.conversations.lastSyncedMessageUuid = result.lastProcessedMessageUuid;
        sessionMetadata.sync.conversations.lastSyncedHistoryIndex = result.currentHistoryIndex;
        sessionMetadata.sync.conversations.lastSyncAt = Date.now();
        sessionMetadata.sync.conversations.totalMessagesSynced =
          (sessionMetadata.sync.conversations.totalMessagesSynced || 0) + result.history.length;
        sessionMetadata.sync.conversations.totalSyncAttempts =
          (sessionMetadata.sync.conversations.totalSyncAttempts || 0) + 1;
      }

      await sessionStore.saveSession(sessionMetadata);

      logger.debug(
        `[${this.name}] Updated sync state: ` +
        `lastSyncedMessageUuid=${result.lastProcessedMessageUuid}, ` +
        `lastSyncedHistoryIndex=${result.currentHistoryIndex}`
      );
      logger.info(
        `[${this.name}] Successfully synced conversation ${conversationId} ` +
        `(${response.new_messages} new, ${response.total_messages} total)`
      );

      return {
        success: true,
        message: result.isTurnContinuation
          ? `Synced turn continuation (${result.history.length} entries)`
          : `Synced new turn (${result.history.length} entries)`,
        metadata: {
          conversationId,
          messagesProcessed: result.history.length,
          isTurnContinuation: result.isTurnContinuation
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
