/**
 * Conversation History Persister
 *
 * Appends user/assistant turn records to `~/.codemie/sessions/<id>_conversation.jsonl`
 * so subsequent `codemie assistants chat --conversation-id <id> …` calls can resume
 * the same logical conversation even when no codemie agent session backs the id.
 *
 * Used only when `--conversation-id` is passed EXPLICITLY by the caller — not when
 * the value comes from the `CODEMIE_SESSION_ID` env-var fallback, where the agent
 * session's own hook already writes the file and would race with this persister.
 */

import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { logger } from '@/utils/logger.js';
import { getSessionConversationPath } from '@/agents/core/session/session-config.js';
import { readJSONL } from '@/providers/plugins/sso/session/utils/jsonl-reader.js';
import { writeJSONLAtomic } from '@/providers/plugins/sso/session/utils/jsonl-writer.js';
import {
  type ConversationPayloadRecord,
  CONVERSATION_SYNC_STATUS,
} from '@/providers/plugins/sso/session/processors/conversations/types.js';
import { isValidConversationId } from './conversationIdSafety.js';

/**
 * Append one user→assistant turn pair to the conversation JSONL file.
 *
 * Non-fatal on any I/O error: the caller has already received the assistant
 * response, so we never throw out of this function.
 */
export async function appendConversationTurn(
  conversationId: string,
  userMessage: string,
  assistantResponse: string,
  fileNames: string[] = []
): Promise<void> {
  if (!isValidConversationId(conversationId)) {
    logger.error('Refusing to persist conversation turn: invalid conversation id', {
      conversationId,
    });
    return;
  }

  try {
    const filePath = getSessionConversationPath(conversationId);
    await mkdir(dirname(filePath), { recursive: true });

    let existing: ConversationPayloadRecord[] = [];
    if (existsSync(filePath)) {
      existing = await readJSONL<ConversationPayloadRecord>(filePath);
    }

    // Compute the next history_index by scanning all existing turns. Indices
    // produced by other writers (e.g. agent-session hooks) are honoured so
    // historyLoader's `${role}:${message}:${history_index}` dedup behaves.
    const maxIndex = existing
      .flatMap(r => r.payload?.history ?? [])
      .reduce((max, msg) => Math.max(max, msg.history_index ?? -1), -1);
    const userIndex = maxIndex + 1;
    const assistantIndex = userIndex + 1;

    const now = new Date().toISOString();
    const record: ConversationPayloadRecord = {
      payloadId: `cli-${conversationId}-${userIndex}`,
      timestamp: Date.now(),
      isTurnContinuation: false,
      historyIndices: [userIndex, assistantIndex],
      messageCount: 2,
      payload: {
        conversationId,
        history: [
          {
            role: 'User',
            message: userMessage,
            history_index: userIndex,
            date: now,
            message_raw: userMessage,
            file_names: fileNames,
          },
          {
            role: 'Assistant',
            message: assistantResponse,
            history_index: assistantIndex,
            date: now,
            message_raw: assistantResponse,
            file_names: [],
          },
        ],
      },
      status: CONVERSATION_SYNC_STATUS.SUCCESS,
    };

    await writeJSONLAtomic(filePath, [...existing, record]);

    logger.debug('Persisted conversation turn', {
      conversationId,
      filePath,
      userIndex,
      assistantIndex,
      totalRecords: existing.length + 1,
    });
  } catch (error) {
    logger.error('Failed to persist conversation turn', {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
