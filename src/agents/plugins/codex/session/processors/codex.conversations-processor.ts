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
import type { ConversationPayloadRecord } from '../../../../../providers/plugins/sso/session/processors/conversations/types.js';
import { CONVERSATION_SYNC_STATUS } from '../../../../../providers/plugins/sso/session/processors/conversations/types.js';
import { CODEMIE_ASSISTANT_ID } from '../../../../../providers/plugins/sso/session/processors/conversations/constants.js';
import { getSessionConversationPath } from '../../../../core/session/session-config.js';
import { logger } from '../../../../../utils/logger.js';

interface CodexConversationMessage {
  role: 'User' | 'Assistant';
  message: string;
  date: string;
  sourceIndex: number;
}

interface CodexConversationTurn {
  user?: CodexConversationMessage;
  assistants: CodexConversationMessage[];
  historyIndex: number;
}

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
      const llmModel = typeof metadata?.model === 'string' && metadata.model.trim()
        ? metadata.model
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
      const persistedHistoryIndex = sessionMetadata?.sync?.conversations?.lastSyncedHistoryIndex ?? -1;
      const lastSyncedSourceIndex = parseLastSyncedSourceIndex(
        sessionMetadata?.sync?.conversations?.lastSyncedMessageUuid,
        persistedHistoryIndex
      );

      const records = session.messages as CodexRolloutRecord[];
      const normalizedMessages: CodexConversationMessage[] = [];

      for (const [sourceIndex, record] of records.entries()) {
        const timestamp = resolveRecordTimestamp(record, metadata?.createdAt);
        if (record.type === 'event_msg') {
          const event = record.payload as CodexEventMsg;
          if (event.type === 'user_message' && event.message) {
            normalizedMessages.push({
              role: 'User',
              message: event.message,
              date: timestamp,
              sourceIndex,
            });
          }
        } else if (record.type === 'response_item') {
          const item = record.payload as CodexResponseItem;
          const role = typeof (item as unknown as { role?: unknown }).role === 'string'
            ? (item as unknown as { role: string }).role
            : undefined;
          const content = extractMessageContent(item);
          if (item.type === 'message' && role === 'assistant' && content) {
            normalizedMessages.push({
              role: 'Assistant',
              message: content,
              date: timestamp,
              sourceIndex,
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

      const conversationsPath = getSessionConversationPath(session.sessionId);
      const { readJSONL } = await import('../../../../../providers/plugins/sso/session/utils/jsonl-reader.js');
      const existingPayloads = await readJSONL<ConversationPayloadRecord>(conversationsPath);
      const queuedCheckpoint = getQueuedCheckpoint(existingPayloads);
      const effectiveSourceIndex = Math.max(lastSyncedSourceIndex, queuedCheckpoint.sourceIndex);
      const effectiveHistoryIndex = Math.max(persistedHistoryIndex, queuedCheckpoint.historyIndex);
      const newMessages = normalizedMessages.filter(message => message.sourceIndex > effectiveSourceIndex);

      if (newMessages.length === 0) {
        logger.debug(
          `[codex-conversations] No new messages past source index ${effectiveSourceIndex} for session ${codexSessionId}`
        );
        return {
          success: true,
          message: 'No new conversation messages',
          metadata: { recordsProcessed: 0 }
        };
      }

      const turns = buildTurns(newMessages, effectiveHistoryIndex);

      if (turns.length === 0) {
        return {
          success: true,
          message: 'No complete conversation turns',
          metadata: { recordsProcessed: 0 }
        };
      }

      const endSourceIndex = Math.max(...newMessages.map(message => message.sourceIndex));
      const sentinel = `${codexSessionId}@${endSourceIndex}`;

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

      const history = turns.flatMap(turn => turnToHistory(turn));

      const { appendFile, mkdir } = await import('fs/promises');
      const { dirname } = await import('path');
      await mkdir(dirname(conversationsPath), { recursive: true });

      const payloadRecord: ConversationPayloadRecord = {
        payloadId: sentinel,
        timestamp: Date.now(),
        isTurnContinuation: turns.some(turn => !turn.user),
        historyIndices: history.map(entry => entry.history_index),
        messageCount: history.length,
        lastProcessedMessageUuid: sentinel,
        payload: {
          conversationId: context.agentSessionId || codexSessionId,
          assistantId: CODEMIE_ASSISTANT_ID,
          folder: 'codex',
          llmModel,
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
          userMessages: newMessages.filter(m => m.role === 'User').length,
          assistantMessages: newMessages.filter(m => m.role === 'Assistant').length,
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

function parseLastSyncedSourceIndex(value: unknown, fallback: number): number {
  if (typeof value === 'string') {
    const index = Number.parseInt(value.slice(value.lastIndexOf('@') + 1), 10);
    if (Number.isFinite(index)) {
      return index;
    }
  }
  return fallback;
}

function getQueuedCheckpoint(payloads: ConversationPayloadRecord[]): { sourceIndex: number; historyIndex: number } {
  let sourceIndex = -1;
  let historyIndex = -1;

  for (const payload of payloads) {
    sourceIndex = Math.max(
      sourceIndex,
      parseLastSyncedSourceIndex(payload.lastProcessedMessageUuid, -1)
    );

    if (payload.historyIndices.length > 0) {
      historyIndex = Math.max(historyIndex, Math.max(...payload.historyIndices));
    }
  }

  return { sourceIndex, historyIndex };
}

function buildTurns(messages: CodexConversationMessage[], lastSyncedHistoryIndex: number): CodexConversationTurn[] {
  const turns: CodexConversationTurn[] = [];
  let current: CodexConversationTurn | undefined;
  let nextHistoryIndex = lastSyncedHistoryIndex + 1;

  for (const message of messages) {
    if (message.role === 'User') {
      current = {
        user: message,
        assistants: [],
        historyIndex: nextHistoryIndex++,
      };
      turns.push(current);
      continue;
    }

    if (!current) {
      if (lastSyncedHistoryIndex < 0) {
        continue;
      }
      current = {
        assistants: [],
        historyIndex: lastSyncedHistoryIndex,
      };
      turns.push(current);
    }

    current.assistants.push(message);
  }

  return turns.filter(turn => turn.user || turn.assistants.length > 0);
}

function turnToHistory(turn: CodexConversationTurn): any[] {
  const history: any[] = [];

  if (turn.user) {
    history.push({
      role: 'User',
      message: turn.user.message,
      message_raw: turn.user.message,
      date: turn.user.date,
      history_index: turn.historyIndex,
      file_names: [],
    });
  }

  const finalAssistant = turn.assistants[turn.assistants.length - 1];
  if (finalAssistant) {
    history.push({
      role: 'Assistant',
      message: finalAssistant.message,
      date: finalAssistant.date,
      history_index: turn.historyIndex,
      response_time: turn.user ? calculateResponseTime(turn.user.date, finalAssistant.date) : undefined,
      assistant_id: CODEMIE_ASSISTANT_ID,
      thoughts: turn.assistants.map((assistant, index) => createCodemieThought(assistant, turn.historyIndex, index)),
    });
  }

  return history;
}

function createCodemieThought(message: CodexConversationMessage, historyIndex: number, index: number): Record<string, unknown> {
  return {
    id: `codex-${historyIndex}-${index}-${message.sourceIndex}`,
    parent_id: null,
    metadata: { timestamp: message.date },
    in_progress: false,
    input_text: '',
    message: message.message,
    author_type: 'Tool',
    author_name: 'Codemie Thoughts',
    output_format: 'text',
    error: false,
    interrupted: false,
    aborted: false,
    children: [],
  };
}

function calculateResponseTime(start: string, end: string): number | undefined {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return undefined;
  }
  return Math.max(0, Math.round(((endMs - startMs) / 1000) * 100) / 100);
}

function resolveRecordTimestamp(record: CodexRolloutRecord, fallback: unknown): string {
  const recordTimestamp = (record as { timestamp?: unknown }).timestamp;
  if (typeof recordTimestamp === 'string' && recordTimestamp.trim()) {
    return recordTimestamp;
  }
  if (typeof fallback === 'string' && fallback.trim()) {
    return fallback;
  }
  return new Date().toISOString();
}

function extractMessageContent(item: CodexResponseItem): string | undefined {
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
