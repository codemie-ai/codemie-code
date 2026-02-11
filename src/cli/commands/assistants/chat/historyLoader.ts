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
const MAX_HISTORY_MESSAGES = 20;
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
    const validRecords = records.filter(
      record => record.status === CONVERSATION_SYNC_STATUS.SUCCESS ||
                record.status === CONVERSATION_SYNC_STATUS.PENDING
    );

    if (validRecords.length === 0) {
      logger.debug('No valid conversation records found', {
        conversationId,
        totalRecords: records.length
      });
      return [];
    }

    const allMessages = validRecords
      .flatMap(record => record.payload?.history ?? [])
      .reduce((map, msg) => {
        const key = `${msg.role}:${msg.message}:${msg.history_index ?? 0}`;
        if (!map.has(key)) {
          map.set(key, {
            role: msg.role,
            message: msg.message,
            message_raw: msg.message
          });
        }
        return map;
      }, new Map<string, HistoryMessage>());

    if (allMessages.size === 0) {
      logger.debug('No history messages found in conversation records', {
        conversationId
      });
      return [];
    }

    const allHistory: HistoryMessage[] = Array.from(allMessages.values());
    return allHistory.slice(-MAX_HISTORY_MESSAGES);
  } catch (error) {
    logger.error('Failed to load conversation history', {
      conversationId,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}
