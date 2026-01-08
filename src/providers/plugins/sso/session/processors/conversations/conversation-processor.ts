/**
 * Conversations Processor (Agent-Agnostic)
 *
 * Processes parsed session data to sync conversations to CodeMie API with incremental tracking.
 *
 * Responsibilities:
 * - Extract NEW messages from ParsedSession (incremental tracking via processedRecordIds)
 * - Transform to Codemie conversation format (via agent's conversations adapter)
 * - Send ONLY new messages to conversations API
 * - Track conversationId (set from sessionId, no UUID generation)
 *
 * IMPORTANT: This processor is agent-agnostic.
 * Agent-specific logic (transformer) is loaded from agent plugin.
 *
 * Design:
 * - Uses metrics SessionStore for message-level tracking (processedRecordIds)
 * - conversationId = sessionId (copied on first sync, no UUID generation)
 * - Only syncs NEW messages (incremental updates)
 * - Waits for metrics processor to populate processedRecordIds
 * - On first sync (no conversationId), processes all messages in processedRecordIds
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../base/BaseProcessor.js';
import type { ParsedSession } from '../../adapters/base/BaseSessionAdapter.js';
import { logger } from '../../../../../../utils/logger.js';
import { ConversationApiClient } from './conversation-api-client.js';

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

      // Check 1: Empty messages
      if (messages.length === 0) {
        logger.debug(`[${this.name}] No messages in session ${session.sessionId}`);
        return { success: true, message: 'No messages to process' };
      }

      // Check 2: Load session metadata from metrics SessionStore
      const { SessionStore } = await import('../../../../../../agents/core/metrics/session/SessionStore.js');
      const sessionStore = new SessionStore();
      const sessionMetadata = await sessionStore.loadSession(session.sessionId);

      if (!sessionMetadata) {
        logger.debug(`[${this.name}] Session metadata not found for ${session.sessionId}`);
        return { success: false, message: 'Session metadata not found' };
      }

      // Check 3: Get processed records (wait for metrics if empty)
      const processedRecordIds = sessionMetadata.syncState?.processedRecordIds || [];

      if (processedRecordIds.length === 0) {
        logger.debug(`[${this.name}] Waiting for metrics processor to populate processedRecordIds`);
        return { success: true, message: 'Waiting for metrics' };
      }

      // Check 4: Determine if this is first sync (no conversationId yet)
      const isFirstSync = !sessionMetadata.syncState?.conversationId;

      // Check 5: Find new messages (incremental tracking)
      let newMessages: any[];

      if (isFirstSync) {
        // First sync: Process all messages in processedRecordIds
        newMessages = messages;
        logger.info(`[${this.name}] First sync for session ${session.sessionId}, processing all ${messages.length} messages`);
      } else {
        // Subsequent syncs: Only process NEW messages
        const lastProcessedUuid = processedRecordIds[processedRecordIds.length - 1];
        const lastProcessedIndex = messages.findIndex((m: any) => m.uuid === lastProcessedUuid);

        if (lastProcessedIndex === -1) {
          // UUID not found - session reset
          newMessages = messages;
          logger.warn(`[${this.name}] Session reset detected for ${session.sessionId}, re-syncing all ${messages.length} messages`);
        } else if (lastProcessedIndex === messages.length - 1) {
          // No new messages
          logger.debug(`[${this.name}] No new messages for session ${session.sessionId}`);
          return { success: true, message: 'No new messages' };
        } else {
          // Extract new messages (after last processed)
          newMessages = messages.slice(lastProcessedIndex + 1);
          logger.info(`[${this.name}] Processing ${newMessages.length} new messages for session ${session.sessionId}`);
        }
      }

      // Get agent from registry
      const { AgentRegistry } = await import('../../../../../../agents/registry.js');
      const agent = AgentRegistry.getAgent(session.agentName);

      if (!agent) {
        logger.error(`[${this.name}] Agent not found in registry: ${session.agentName}`);
        return { success: false, message: `Agent not found: ${session.agentName}` };
      }

      // Get agent display name from metadata
      const agentDisplayName = (agent as any)?.metadata?.displayName || agent.name;

      // Get conversations adapter from agent
      const conversationsAdapter = (agent as any).getConversationsAdapter?.();

      if (!conversationsAdapter) {
        logger.warn(`[${this.name}] No conversations adapter available for agent: ${session.agentName}`);
        return { success: true, message: 'Conversations sync not supported for this agent' };
      }

      // Get or create conversationId (from sessionId, no UUID generation)
      const conversationId = sessionMetadata.syncState?.conversationId || session.sessionId;

      // Transform only new messages to Codemie format via agent's adapter
      const history = conversationsAdapter.transformMessages(
        newMessages,
        '5a430368-9e91-4564-be20-989803bf4da2',  // assistant_id (from original)
        agentDisplayName
      );

      if (history.length === 0) {
        logger.debug(`[${this.name}] No history after transformation for session ${session.sessionId}`);
        return { success: true, message: 'No history after transformation' };
      }

      logger.info(`[${this.name}] Syncing conversation ${conversationId} for session ${session.sessionId} (${history.length} messages)`);

      // Initialize API client
      const apiClient = new ConversationApiClient({
        baseUrl: context.apiBaseUrl,
        cookies: context.cookies,
        timeout: 30000,
        retryAttempts: 3,
        version: context.version,
        clientType: context.clientType,
        dryRun: context.dryRun
      });

      // Send to API with specified assistant_id
      const response = await apiClient.upsertConversation(
        conversationId,
        history,
        '5a430368-9e91-4564-be20-989803bf4da2',  // Specified assistant_id (from original)
        agentDisplayName  // Collection name (uses agent display name: "Claude Code", "Codex", etc.)
      );

      if (!response.success) {
        logger.error(`[${this.name}] Failed to sync conversation ${conversationId}: ${response.message}`);
        return { success: false, message: `Failed to sync conversation: ${response.message}` };
      }

      // Save conversationId (if first sync) - set from sessionId
      if (!sessionMetadata.syncState?.conversationId) {
        // Update syncState with conversationId
        sessionMetadata.syncState = {
          ...sessionMetadata.syncState!,
          conversationId: session.sessionId  // Copy sessionId to conversationId
        };
        await sessionStore.saveSession(sessionMetadata);
        logger.debug(`[${this.name}] Saved conversationId=${session.sessionId} for session ${session.sessionId}`);
      }

      logger.info(`[${this.name}] Successfully synced conversation ${conversationId} (${response.new_messages} new, ${response.total_messages} total)`);

      return {
        success: true,
        message: `Synced ${newMessages.length} new messages`,
        metadata: {
          conversationId,
          messagesProcessed: history.length
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
