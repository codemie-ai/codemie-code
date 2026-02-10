/**
 * Conversation History Loader
 *
 * Loads conversation history from session files stored in ~/.codemie/sessions
 */

import { existsSync } from 'fs';

/**
 * Maximum number of history messages to load from previous sessions
 * This prevents sending excessively large context to the API
 */
const MAX_HISTORY_MESSAGES = 10;
import { logger } from '@/utils/logger.js';
import { getSessionConversationPath } from '@/agents/core/session/session-config.js';
import { readJSONL } from '@/providers/plugins/sso/session/utils/jsonl-reader.js';
import {
  type ConversationPayloadRecord,
  CONVERSATION_SYNC_STATUS
} from '@/providers/plugins/sso/session/processors/conversations/conversation-types.js';
import type { HistoryMessage } from '../constants.js';

/**
 * Load conversation history from session files
 *
 * @param conversationId - Optional conversation ID to load history for
 * @returns Array of history messages, or empty array if none found or on error
 *
 * @example
 * ```ts
 * const history = await loadConversationHistory('abc-123');
 * console.log(`Loaded ${history.length} messages`);
 * ```
 */
export async function loadConversationHistory(
  conversationId: string | undefined
): Promise<HistoryMessage[]> {
  if (!conversationId) return [];

  try {
    const filePath = getSessionConversationPath(conversationId);

    // File doesn't exist yet - normal for first-time conversations
    if (!existsSync(filePath)) {
      logger.debug('Conversation history file not found (first-time conversation)', {
        conversationId,
        filePath
      });
      return [];
    }

    const records = await readJSONL<ConversationPayloadRecord>(filePath);
    const successRecords = records.filter(record => record.status === CONVERSATION_SYNC_STATUS.SUCCESS);

    if (successRecords.length === 0) {
      logger.debug('No successful conversation records found', {
        conversationId,
        totalRecords: records.length
      });
      return [];
    }

    // Take the most recent success record (last in array)
    const latestRecord = successRecords[successRecords.length - 1];

    // Extract and transform history from the record
    if (!latestRecord.payload?.history || latestRecord.payload.history.length === 0) {
      logger.debug('Latest conversation record has no history', {
        conversationId
      });
      return [];
    }

    // Transform to HistoryMessage format (role + message + message_raw)
    const allHistory: HistoryMessage[] = latestRecord.payload.history.map(msg => ({
      role: msg.role,
      message: msg.message,
      message_raw: msg.message
    }));

    // Limit to the last MAX_HISTORY_MESSAGES to prevent excessive context size
    const history = allHistory.slice(-MAX_HISTORY_MESSAGES);

    logger.debug('Successfully loaded conversation history', {
      conversationId,
      messageCount: history.length,
      totalMessages: allHistory.length,
      truncated: allHistory.length > MAX_HISTORY_MESSAGES,
      recordTimestamp: latestRecord.timestamp
    });

    return history;

  } catch (error) {
    logger.error('Failed to load conversation history', {
      conversationId,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}
