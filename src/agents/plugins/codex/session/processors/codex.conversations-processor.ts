// src/agents/plugins/codex/session/processors/codex.conversations-processor.ts
/**
 * Codex Conversations Processor
 *
 * Normalises user messages and assistant responses from Codex rollout records
 * into a unified conversation format.
 *
 * This processor is a placeholder for Phase 2 conversation sync.
 * It runs and normalises data but does not write to the API in the initial delivery.
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import type {
  CodexRolloutRecord,
  CodexResponseItem,
  CodexEventMsg,
  CodexSessionMetadata,
} from '../../codex-message-types.js';
import type { BaseNormalizedMessage } from '../../../../core/session/types.js';
import type { ConversationPayloadRecord } from '../../../../../providers/plugins/sso/session/processors/conversations/types.js';
import { CONVERSATION_SYNC_STATUS } from '../../../../../providers/plugins/sso/session/processors/conversations/types.js';
import { getSessionConversationPath } from '../../../../core/session/session-config.js';
import { logger } from '../../../../../utils/logger.js';

export class CodexConversationsProcessor implements SessionProcessor {
  readonly name = 'codex-conversations';
  readonly priority = 2;

  shouldProcess(session: ParsedSession): boolean {
    return session.messages.length > 0;
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const metadata = session.metadata as CodexSessionMetadata | undefined;
      const codexSessionId = typeof metadata?.codexSessionId === 'string'
        ? metadata.codexSessionId
        : undefined;

      if (!codexSessionId) {
        return {
          success: false,
          message: 'Missing codexSessionId in session.metadata',
          metadata: { failureReason: 'NO_CODEX_SESSION_ID' }
        };
      }

      const { SessionStore } = await import('../../../../core/session/SessionStore.js');
      const sessionStore = new SessionStore();
      const sessionMetadata = await sessionStore.loadSession(session.sessionId);
      const lastSyncedHistoryIndex = sessionMetadata?.sync?.conversations?.lastSyncedHistoryIndex ?? -1;

      const records = session.messages as CodexRolloutRecord[];
      const normalizedMessages: BaseNormalizedMessage[] = [];
      const timestamp = resolveTimestamp(metadata?.createdAt);

      for (const record of records) {
        if (record.type === 'event_msg') {
          const event = record.payload as CodexEventMsg;
          if (event.type === 'user_message' && event.message) {
            normalizedMessages.push({
              role: 'user',
              content: event.message,
              timestamp,
            });
          }
        } else if (record.type === 'response_item') {
          const item = record.payload as CodexResponseItem;
          const content = extractAssistantContent(item);
          if (item.type === 'message' && content) {
            normalizedMessages.push({
              role: 'assistant',
              content,
              timestamp,
            });
          }
        }
      }

      logger.debug(
        `[codex-conversations] Normalised ${normalizedMessages.length} messages`
      );

      if (normalizedMessages.length === 0) {
        return {
          success: true,
          message: 'No conversation messages generated',
          metadata: { recordsProcessed: 0 }
        };
      }

      const startIndex = lastSyncedHistoryIndex + 1;
      const newMessages = normalizedMessages.slice(startIndex);

      if (newMessages.length === 0) {
        logger.debug(
          `[codex-conversations] No new messages past index ${lastSyncedHistoryIndex} for session ${codexSessionId}`
        );
        return {
          success: true,
          message: 'No new conversation messages',
          metadata: { recordsProcessed: 0 }
        };
      }

      const endIndex = startIndex + newMessages.length - 1;
      const sentinel = `${codexSessionId}@${endIndex}`;

      const conversationsPath = getSessionConversationPath(session.sessionId);
      const { readJSONL } = await import('../../../../../providers/plugins/sso/session/utils/jsonl-reader.js');
      const existingPayloads = await readJSONL<ConversationPayloadRecord>(conversationsPath);
      const alreadyQueued = existingPayloads.some(payload =>
        payload.lastProcessedMessageUuid === sentinel
      );

      if (alreadyQueued) {
        logger.debug(
          `[codex-conversations] Window ${sentinel} already queued, skipping`
        );
        return {
          success: true,
          message: 'Window already queued',
          metadata: { recordsProcessed: 0 }
        };
      }

      const history = newMessages.map((message, offset) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp ? resolveTimestampMs(message.timestamp) : Date.now(),
        history_index: startIndex + offset,
      }));

      const { appendFile, mkdir } = await import('fs/promises');
      const { dirname } = await import('path');
      await mkdir(dirname(conversationsPath), { recursive: true });

      const payloadRecord: ConversationPayloadRecord = {
        timestamp: Date.now(),
        isTurnContinuation: startIndex > 0,
        historyIndices: history.map(entry => entry.history_index),
        messageCount: history.length,
        lastProcessedMessageUuid: sentinel,
        payload: {
          conversationId: context.agentSessionId || codexSessionId,
          history,
        },
        status: CONVERSATION_SYNC_STATUS.PENDING,
      };

      await appendFile(conversationsPath, JSON.stringify(payloadRecord) + '\n', 'utf-8');

      return {
        success: true,
        message: `Generated 1 conversation payload with ${newMessages.length} messages`,
        metadata: {
          recordsProcessed: newMessages.length,
          userMessages: newMessages.filter(m => m.role === 'user').length,
          assistantMessages: newMessages.filter(m => m.role === 'assistant').length,
          syncUpdates: {
            conversations: {
              lastSyncedMessageUuid: sentinel,
              lastSyncedHistoryIndex: endIndex,
              conversationId: context.agentSessionId || codexSessionId,
            }
          }
        }
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[codex-conversations] Processing failed:', error);
      return {
        success: false,
        message: `Conversations processing failed: ${errorMessage}`,
      };
    }
  }
}

function resolveTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function resolveTimestampMs(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function extractAssistantContent(item: CodexResponseItem): string | undefined {
  if (typeof item.output === 'string' && item.output.trim()) {
    return item.output;
  }

  const maybeContent = (item as unknown as { content?: unknown }).content;
  if (typeof maybeContent === 'string' && maybeContent.trim()) {
    return maybeContent;
  }

  if (Array.isArray(maybeContent)) {
    const parts = maybeContent
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') return text;
        }
        return undefined;
      })
      .filter((part): part is string => Boolean(part?.trim()));

    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  return undefined;
}
