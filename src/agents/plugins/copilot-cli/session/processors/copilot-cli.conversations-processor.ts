/**
 * Conversations processor for Copilot CLI sessions.
 *
 * Copilot persists prompt text in `events.jsonl`; `parseSessionFile` captures it into
 * `ParsedSession.messages`. Unlike Claude and Pi, Copilot does not currently emit
 * mid-turn hook events through CodeMie, so this processor drains the whole discovered
 * transcript on SessionEnd and appends pending payload windows to the standard
 * `_conversation.jsonl` spool for the shared sync pipeline.
 */

import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type {
  SessionProcessor,
  ProcessingContext,
  ProcessingResult,
} from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import { getSessionConversationPath } from '../../../../core/session/session-config.js';
import { CODEMIE_ASSISTANT_ID, CONVERSATION_PROCESSOR_NAME } from '../../../../../providers/plugins/sso/session/processors/conversations/constants.js';
import type { ConversationPayloadRecord } from '../../../../../providers/plugins/sso/session/processors/conversations/types.js';
import { CONVERSATION_SYNC_STATUS } from '../../../../../providers/plugins/sso/session/processors/conversations/types.js';
import { readJSONL } from '../../../../../providers/plugins/sso/session/utils/jsonl-reader.js';
import { logger } from '../../../../../utils/logger.js';

interface CopilotTurnRecord {
  role?: 'user' | 'assistant';
  timestamp?: string;
  message?: {
    role?: 'user' | 'assistant';
    content?: string;
    model?: string;
    toolRequests?: Array<{
      toolCallId?: string;
      name?: string;
      arguments?: unknown;
    }>;
  };
}

type CopilotThought = {
  id: string;
  parent_id: string | null;
  metadata: Record<string, unknown>;
  in_progress: boolean;
  input_text: string;
  message: string;
  author_type: 'Tool' | 'Agent';
  author_name: string;
  output_format: string;
  error: boolean;
  interrupted: boolean;
  aborted: boolean;
  children: unknown[];
};

type CopilotEventKind = 'assistant_commentary' | 'tool_call' | 'tool_output';

interface CopilotTurnEvent {
  kind: CopilotEventKind;
  sourceIndex: number;
  timestamp?: string;
  text?: string;
  callId?: string;
  toolName?: string;
  inputText?: string;
  error?: boolean;
  metadata?: Record<string, unknown>;
}

interface CopilotConversationTurn {
  historyIndex: number;
  user?: { text: string; timestamp?: string };
  assistant?: { text: string; timestamp?: string; model?: string };
  events: CopilotTurnEvent[];
}

function asTurnRecord(value: unknown): CopilotTurnRecord | null {
  if (!value || typeof value !== 'object') return null;
  return value as CopilotTurnRecord;
}

function parseTimestampMs(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function calculateResponseTimeSeconds(start?: string, end?: string): number | undefined {
  const startMs = parseTimestampMs(start);
  const endMs = parseTimestampMs(end);
  if (startMs === undefined || endMs === undefined || endMs < startMs) {
    return undefined;
  }
  return Math.max(0, Math.round(((endMs - startMs) / 1000) * 100) / 100);
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildThoughts(events: CopilotTurnEvent[], historyIndex: number): CopilotThought[] {
  const thoughts: CopilotThought[] = [];
  const toolThoughtByCallId = new Map<string, CopilotThought>();

  for (const event of events) {
    if (event.kind === 'assistant_commentary') {
      if (!event.text?.trim()) continue;
      thoughts.push({
        id: `copilot-commentary-${historyIndex}-${event.sourceIndex}`,
        parent_id: null,
        metadata: {
          timestamp: event.timestamp,
          source_index: event.sourceIndex,
          event_kind: event.kind,
          ...(event.metadata ?? {}),
        },
        in_progress: false,
        input_text: '',
        message: event.text,
        author_type: 'Agent',
        author_name: 'GitHub Copilot CLI',
        output_format: 'text',
        error: false,
        interrupted: false,
        aborted: false,
        children: [],
      });
      continue;
    }

    if (event.kind === 'tool_output') {
      const pending = event.callId ? toolThoughtByCallId.get(event.callId) : undefined;
      if (pending) {
        pending.message = event.text ?? '';
        pending.error = event.error === true;
        pending.metadata = {
          ...pending.metadata,
          output_source_index: event.sourceIndex,
          output_timestamp: event.timestamp,
          ...(event.metadata ?? {}),
        };
        toolThoughtByCallId.delete(event.callId!);
        continue;
      }
    }

    const thought: CopilotThought = {
      id: event.callId || `copilot-tool-${historyIndex}-${event.sourceIndex}`,
      parent_id: null,
      metadata: {
        timestamp: event.timestamp,
        source_index: event.sourceIndex,
        event_kind: event.kind,
        ...(event.callId && { call_id: event.callId }),
        ...(event.metadata ?? {}),
      },
      in_progress: false,
      input_text: event.inputText ?? '',
      message: event.text ?? '',
      author_type: 'Tool',
      author_name: event.toolName || 'Unknown Tool',
      output_format: 'text',
      error: event.error === true,
      interrupted: false,
      aborted: false,
      children: [],
    };
    thoughts.push(thought);
    if (event.kind === 'tool_call' && event.callId) {
      toolThoughtByCallId.set(event.callId, thought);
    }
  }

  return thoughts;
}

function toHistory(turn: CopilotConversationTurn): any[] {
  const history: any[] = [];

  if (turn.user?.text) {
    history.push({
      role: 'User',
      message: turn.user.text,
      message_raw: turn.user.text,
      history_index: turn.historyIndex,
      date: turn.user.timestamp,
      file_names: [],
    });
  }

  if (turn.assistant?.text) {
    const thoughts = buildThoughts(turn.events, turn.historyIndex);
    history.push({
      role: 'Assistant',
      message: turn.assistant.text,
      message_raw: turn.assistant.text,
      history_index: turn.historyIndex,
      date: turn.assistant.timestamp,
      response_time: calculateResponseTimeSeconds(turn.user?.timestamp, turn.assistant.timestamp),
      assistant_id: CODEMIE_ASSISTANT_ID,
      thoughts: thoughts.length > 0 ? thoughts : undefined,
    });
  }

  return history;
}

function buildTurns(messages: unknown[]): CopilotConversationTurn[] {
  const turns: CopilotConversationTurn[] = [];
  let current: CopilotConversationTurn | null = null;
  let historyIndex = -1;

  for (const [sourceIndex, raw] of messages.entries()) {
    const record = asTurnRecord(raw);
    const role = record?.message?.role;
    const content = record?.message?.content?.trim();

    if (!role || !content) {
      continue;
    }

    if (role === 'user') {
      historyIndex += 1;
      current = {
        historyIndex,
        user: {
          text: content,
          timestamp: record.timestamp,
        },
        events: [],
      };
      turns.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    current.assistant = {
      text: content,
      timestamp: record.timestamp,
      model: record.message?.model,
    };

    const toolRequests = Array.isArray(record.message?.toolRequests)
      ? record.message?.toolRequests
      : [];

    if (toolRequests.length > 0) {
      for (const request of toolRequests) {
        current.events.push({
          kind: 'tool_call',
          sourceIndex,
          timestamp: record.timestamp,
          callId: request.toolCallId,
          toolName: request.name,
          inputText: stringify(request.arguments),
          metadata: {
            tool_arguments: request.arguments,
          },
        });
      }
    } else {
      current.events.push({
        kind: 'assistant_commentary',
        sourceIndex,
        timestamp: record.timestamp,
        text: content,
      });
    }
  }

  return turns;
}

export class CopilotCliConversationsProcessor implements SessionProcessor {
  readonly name = 'copilot-cli-conversations';
  readonly priority = 2;

  shouldProcess(session: ParsedSession): boolean {
    if (process.env.CODEMIE_CONV_SYNC_DISABLED === '1') return false;
    return session.messages.length > 0;
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    const conversationId = context.agentSessionId?.trim();
    if (!conversationId) {
      logger.warn(`[${this.name}] Missing agentSessionId for session ${session.sessionId}; skipping conversation sync`);
      return {
        success: true,
        message: 'Skipped: missing Copilot conversation id',
        metadata: { recordsProcessed: 0, skipReason: 'MISSING_CONVERSATION_ID' },
      };
    }

    const turns = buildTurns(session.messages);
    if (turns.length === 0) {
      return {
        success: true,
        message: 'No conversation turns generated',
        metadata: { recordsProcessed: 0 },
      };
    }

    const conversationsPath = getSessionConversationPath(session.sessionId);
    await mkdir(dirname(conversationsPath), { recursive: true });

    const existingPayloads = await readJSONL<ConversationPayloadRecord>(conversationsPath);

    const { SessionStore } = await import('../../../../core/session/SessionStore.js');
    const sessionStore = new SessionStore();
    const sessionMetadata = await sessionStore.loadSession(session.sessionId);

    let lastHistoryIndex = sessionMetadata?.sync?.conversations?.lastSyncedHistoryIndex ?? -1;
    for (const payload of existingPayloads) {
      if (payload.payload.conversationId !== conversationId) continue;
      for (const idx of payload.historyIndices) {
        lastHistoryIndex = Math.max(lastHistoryIndex, idx);
      }
    }

    let payloadsWritten = 0;
    let recordsProcessed = 0;
    let lastSentinel: string | undefined;
    let lastModel: string | undefined;

    for (const turn of turns) {
      if (turn.historyIndex <= lastHistoryIndex) {
        continue;
      }

      const history = toHistory(turn);
      if (history.length === 0) {
        continue;
      }

      const sentinel = `${conversationId}@${turn.historyIndex}`;
      const payloadRecord: ConversationPayloadRecord = {
        payloadId: sentinel,
        timestamp: Date.now(),
        isTurnContinuation: false,
        historyIndices: history.map((entry: any) => entry.history_index),
        messageCount: history.length,
        lastProcessedMessageUuid: sentinel,
        payload: {
          conversationId,
          history,
          assistantId: CODEMIE_ASSISTANT_ID,
          llmModel: turn.assistant?.model,
        },
        status: CONVERSATION_SYNC_STATUS.PENDING,
      };

      await appendFile(conversationsPath, JSON.stringify(payloadRecord) + '\n');

      payloadsWritten += 1;
      recordsProcessed += history.length;
      lastHistoryIndex = turn.historyIndex;
      lastSentinel = sentinel;
      lastModel = turn.assistant?.model ?? lastModel;
    }

    if (payloadsWritten === 0) {
      return {
        success: true,
        message: 'No new conversation payloads',
        metadata: { recordsProcessed: 0 },
      };
    }

    logger.info(
      `[${CONVERSATION_PROCESSOR_NAME}] Queued ${payloadsWritten} Copilot conversation payload` +
      `${payloadsWritten === 1 ? '' : 's'} for session ${session.sessionId}`
    );

    return {
      success: true,
      message: `Queued ${payloadsWritten} Copilot conversation payload(s)`,
      metadata: {
        recordsProcessed,
        payloadsWritten,
        syncUpdates: {
          conversations: {
            lastSyncedMessageUuid: lastSentinel,
            lastSyncedHistoryIndex: lastHistoryIndex,
            conversationId,
            totalMessagesSynced: recordsProcessed,
            totalSyncAttempts: 1,
            lastSyncAt: Date.now(),
          },
        },
        llmModel: lastModel,
      },
    };
  }
}
