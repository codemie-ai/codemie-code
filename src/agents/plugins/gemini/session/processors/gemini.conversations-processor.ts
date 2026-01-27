/**
 * Gemini Conversations Processor (Turn-Based Architecture)
 *
 * Transforms Gemini session messages into turn-based conversation records.
 *
 * Key Features:
 * - Turn-based: User + Assistant pairs (not flat messages)
 * - Turn detection: User message → next user/system message
 * - Token aggregation: Across multiple gemini messages in a turn
 * - Tool extraction: From nested Gemini structure
 * - Incremental sync: Tracks lastSyncedMessageUuid
 * - Correct payload: ConversationPayloadRecord with conversationId + history
 *
 * Architecture follows Claude's proven patterns.
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import type { ConversationPayloadRecord } from '../../../../../providers/plugins/sso/session/processors/conversations/conversation-types.js';
import { logger } from '../../../../../utils/logger.js';
import { getSessionConversationPath } from '../../../../core/session/session-config.js';
import { SessionStore } from '../../../../core/session/SessionStore.js';
import { detectTurns, filterNewMessages, type GeminiMessage, type TurnBoundary } from '../utils/turn-detector.js';
import { aggregateTokens } from '../utils/token-aggregator.js';
import { extractToolThoughts } from '../utils/tool-aggregator.js';
import { appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';

export class GeminiConversationsProcessor implements SessionProcessor {
  readonly name = 'gemini-conversations';
  readonly priority = 2; // Run after metrics

  shouldProcess(session: ParsedSession): boolean {
    return Boolean(session.messages && session.messages.length > 0);
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    try {
      // 1. Load sync state
      const sessionStore = new SessionStore();
      const sessionMetadata = await sessionStore.loadSession(context.sessionId!);
      const lastSyncedId = sessionMetadata?.sync?.conversations?.lastSyncedMessageUuid || null;
      const lastHistoryIndex = sessionMetadata?.sync?.conversations?.lastSyncedHistoryIndex ?? -1;

      logger.debug(`[${this.name}] Sync state: lastSyncedId=${lastSyncedId}, lastHistoryIndex=${lastHistoryIndex}`);

      // 2. Filter new messages
      const messages = session.messages as GeminiMessage[];
      const newMessages = filterNewMessages(messages, lastSyncedId);

      if (newMessages.length === 0) {
        logger.info(`[${this.name}] No new messages to process`);
        return { success: true, message: 'No new messages' };
      }

      logger.debug(`[${this.name}] Processing ${newMessages.length} new messages`);

      // 3. Detect turns
      const turns = detectTurns(newMessages);

      if (turns.length === 0) {
        logger.info(`[${this.name}] No complete turns found in ${newMessages.length} messages`);
        return { success: true, message: 'No complete turns' };
      }

      logger.debug(`[${this.name}] Detected ${turns.length} turns`);

      // 4. Transform turns to conversation payloads
      const payloads = this.transformTurnsToPayloads(turns, context, lastHistoryIndex);

      // 5. Write payloads to JSONL
      await this.writePayloads(context.sessionId!, payloads);

      // 6. Update sync state
      const lastMessage = messages[messages.length - 1]; // Use all messages, not just new
      const finalHistoryIndex = lastHistoryIndex + turns.length;

      await this.updateSyncState(
        context.sessionId!,
        lastMessage.id,
        turns.length,
        finalHistoryIndex
      );

      logger.info(`[${this.name}] Processed ${turns.length} turns (${newMessages.length} messages)`);
      return {
        success: true,
        message: `Processed ${turns.length} turns`,
        metadata: {
          turnsProcessed: turns.length,
          messagesProcessed: newMessages.length
        }
      };

    } catch (error) {
      logger.error(`[${this.name}] Processing failed:`, error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Transform turns into ConversationPayloadRecord format
   */
  private transformTurnsToPayloads(
    turns: TurnBoundary[],
    context: ProcessingContext,
    lastHistoryIndex: number
  ): ConversationPayloadRecord[] {
    const payloads: ConversationPayloadRecord[] = [];
    let currentHistoryIndex = lastHistoryIndex;

    for (const turn of turns) {
      currentHistoryIndex++; // Increment for each new turn

      // User record
      const userRecord = {
        role: 'User',
        message: turn.userMessage.content,
        history_index: currentHistoryIndex,
        date: turn.userMessage.timestamp,
        message_raw: turn.userMessage.content,
        file_names: []
      };

      // Aggregate content from all gemini messages
      const aggregatedContent = turn.geminiMessages
        .map(m => m.content)
        .filter(c => c.trim().length > 0)
        .join('\n\n');

      // Aggregate tokens
      const tokens = aggregateTokens(turn.geminiMessages);

      // Extract tool thoughts
      const thoughts = extractToolThoughts(turn.geminiMessages);

      // Calculate response time
      const lastGemini = turn.geminiMessages[turn.geminiMessages.length - 1];
      const responseTimeMs = lastGemini
        ? new Date(lastGemini.timestamp).getTime() - new Date(turn.userMessage.timestamp).getTime()
        : 0;
      const responseTimeSec = Math.round((responseTimeMs / 1000) * 100) / 100; // 2 decimals

      // Assistant record
      const assistantRecord: any = {
        role: 'Assistant',
        message: aggregatedContent,
        message_raw: aggregatedContent,
        history_index: currentHistoryIndex,
        date: lastGemini?.timestamp || turn.userMessage.timestamp,
        response_time: responseTimeSec,
        input_tokens: tokens.input_tokens,
        output_tokens: tokens.output_tokens,
        cache_creation_input_tokens: tokens.cache_creation_input_tokens,
        cache_read_input_tokens: tokens.cache_read_input_tokens,
        assistant_id: '5a430368-9e91-4564-be20-989803bf4da2' // Constant per agent type
      };

      // Add thoughts if present
      if (thoughts.length > 0) {
        assistantRecord.thoughts = thoughts;
      }

      // Create payload
      const payload: ConversationPayloadRecord = {
        timestamp: Date.now(),
        isTurnContinuation: false, // TODO: Detect continuations
        historyIndices: [currentHistoryIndex, currentHistoryIndex],
        messageCount: 2,
        payload: {
          conversationId: context.agentSessionId!, // From processing context
          history: [userRecord, assistantRecord]
        },
        status: 'pending'
      };

      payloads.push(payload);
    }

    return payloads;
  }

  /**
   * Write payloads to conversation JSONL file
   */
  private async writePayloads(sessionId: string, payloads: ConversationPayloadRecord[]): Promise<void> {
    const conversationsPath = getSessionConversationPath(sessionId);
    const outputDir = dirname(conversationsPath);

    // Ensure directory exists
    if (!existsSync(outputDir)) {
      await mkdir(outputDir, { recursive: true });
    }

    // Append each payload as a JSONL line
    for (const payload of payloads) {
      await appendFile(conversationsPath, JSON.stringify(payload) + '\n', 'utf-8');
    }

    logger.debug(`[${this.name}] Wrote ${payloads.length} payloads to ${conversationsPath}`);
  }

  /**
   * Update sync state in session metadata
   */
  private async updateSyncState(
    sessionId: string,
    lastMessageId: string,
    turnsProcessed: number,
    currentHistoryIndex: number
  ): Promise<void> {
    const sessionStore = new SessionStore();
    const session = await sessionStore.loadSession(sessionId);

    if (!session) {
      logger.warn(`[${this.name}] Session not found for sync state update: ${sessionId}`);
      return;
    }

    // Initialize sync structure if needed
    if (!session.sync) {
      session.sync = {};
    }

    if (!session.sync.conversations) {
      session.sync.conversations = {};
    }

    // Update sync state
    session.sync.conversations.lastSyncedMessageUuid = lastMessageId;
    session.sync.conversations.lastSyncedHistoryIndex = currentHistoryIndex;

    await sessionStore.saveSession(session);

    logger.debug(`[${this.name}] Updated sync state: lastSyncedMessageUuid=${lastMessageId}, lastSyncedHistoryIndex=${currentHistoryIndex}`);
  }
}
