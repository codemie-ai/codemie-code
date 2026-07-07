// src/agents/plugins/codex/session/processors/codex.conversations-processor.ts
/**
 * Codex Conversations Processor
 *
 * Transforms raw Codex rollout records into incremental CodeMie conversation
 * payloads while preserving much more of the original interaction shape:
 * - user prompts
 * - assistant commentary / progress updates
 * - reasoning records
 * - tool calls + outputs
 * - sub-agent style tool activity
 *
 * The processor intentionally treats assistant commentary as thoughts rather
 * than user-facing assistant replies. Only final answers become the visible
 * Assistant history entry.
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

type CodexNormalizedEventKind =
  | 'user_prompt'
  | 'assistant_commentary'
  | 'assistant_final'
  | 'assistant_other'
  | 'reasoning'
  | 'tool_call'
  | 'tool_output';

interface CodexNormalizedEvent {
  kind: CodexNormalizedEventKind;
  sourceIndex: number;
  date: string;
  text?: string;
  callId?: string;
  toolName?: string;
  inputText?: string;
  metadata?: Record<string, unknown>;
}

interface CodexConversationTurn {
  user: CodexNormalizedEvent;
  events: CodexNormalizedEvent[];
  historyIndex: number;
  isTurnContinuation: boolean;
}

interface CodexToolThought {
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
}

export class CodexConversationsProcessor implements SessionProcessor {
  readonly name = 'codex-conversations';
  readonly priority = 2;

  shouldProcess(session: ParsedSession): boolean {
    if (process.env.CODEMIE_CONV_SYNC_DISABLED === '1') return false;
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
      const events = normalizeEvents(records, metadata);

      logger.debug(
        `[codex-conversations] Normalised ${events.length} events from ${records.length} rollout records`
      );

      if (events.length === 0) {
        return {
          success: true,
          message: 'No conversation events generated',
          metadata: { recordsProcessed: 0 }
        };
      }

      const conversationsPath = getSessionConversationPath(session.sessionId);
      const { readJSONL } = await import('../../../../../providers/plugins/sso/session/utils/jsonl-reader.js');
      const existingPayloads = await readJSONL<ConversationPayloadRecord>(conversationsPath);
      const queuedCheckpoint = getQueuedCheckpoint(existingPayloads);
      const effectiveSourceIndex = Math.max(lastSyncedSourceIndex, queuedCheckpoint.sourceIndex);
      const effectiveHistoryIndex = Math.max(persistedHistoryIndex, queuedCheckpoint.historyIndex);

      const turn = buildIncrementalTurn(events, effectiveSourceIndex, effectiveHistoryIndex);

      if (!turn) {
        logger.debug(
          `[codex-conversations] No complete incremental turn past source index ${effectiveSourceIndex} for session ${codexSessionId}`
        );
        return {
          success: true,
          message: 'No new conversation messages',
          metadata: { recordsProcessed: 0 }
        };
      }

      const newTurnEvents = turn.events.filter(event => event.sourceIndex > effectiveSourceIndex);
      const endSourceIndex = Math.max(...newTurnEvents.map(event => event.sourceIndex));
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

      const history = turnToHistory(turn, effectiveSourceIndex);

      if (history.length === 0) {
        logger.debug(
          `[codex-conversations] Turn resolved but produced no visible history for ${sentinel}`
        );
        return {
          success: true,
          message: 'No visible history generated',
          metadata: { recordsProcessed: 0 }
        };
      }

      const { appendFile, mkdir } = await import('fs/promises');
      const { dirname } = await import('path');
      await mkdir(dirname(conversationsPath), { recursive: true });

      const payloadRecord: ConversationPayloadRecord = {
        payloadId: sentinel,
        timestamp: Date.now(),
        isTurnContinuation: turn.isTurnContinuation,
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
        message: `Generated 1 conversation payload from ${newTurnEvents.length} new events`,
        metadata: {
          recordsProcessed: newTurnEvents.length,
          userMessages: history.filter(entry => entry.role === 'User').length,
          assistantMessages: history.filter(entry => entry.role === 'Assistant').length,
          syncUpdates: {
            conversations: {
              lastSyncedMessageUuid: sentinel,
              lastSyncedHistoryIndex: turn.historyIndex,
              conversationId: context.agentSessionId || codexSessionId,
              totalMessagesSynced: history.length,
              totalSyncAttempts: 1,
              lastSyncAt: Date.now(),
            },
          },
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

function normalizeEvents(
  records: CodexRolloutRecord[],
  metadata: CodexSessionMetadata | undefined
): CodexNormalizedEvent[] {
  const events: CodexNormalizedEvent[] = [];

  for (const [sourceIndex, record] of records.entries()) {
    const date = resolveRecordTimestamp(record, metadata?.createdAt);

    if (record.type === 'event_msg') {
      const event = record.payload as CodexEventMsg;
      if (event.type === 'user_message' && typeof event.message === 'string' && event.message.trim()) {
        events.push({
          kind: 'user_prompt',
          sourceIndex,
          date,
          text: event.message,
          metadata: { source: 'event_msg.user_message' },
        });
      }
      continue;
    }

    if (record.type !== 'response_item') {
      continue;
    }

    const item = record.payload as CodexResponseItem & {
      role?: unknown;
      phase?: unknown;
      content?: unknown;
      input?: unknown;
      name?: unknown;
      arguments?: unknown;
      encrypted_content?: unknown;
      summary?: unknown;
    };

    if (item.type === 'message') {
      const role = typeof item.role === 'string' ? item.role : undefined;
      const phase = typeof item.phase === 'string' ? item.phase : undefined;
      const text = extractMessageContent(item);

      if (role === 'assistant' && text) {
        if (phase === 'commentary') {
          events.push({
            kind: 'assistant_commentary',
            sourceIndex,
            date,
            text,
            metadata: { phase },
          });
        } else {
          events.push({
            kind: 'assistant_final',
            sourceIndex,
            date,
            text,
            metadata: { phase: phase ?? 'final_answer_or_legacy' },
          });
        }
      } else if (role === 'assistant' && phase === 'commentary') {
        events.push({
          kind: 'assistant_other',
          sourceIndex,
          date,
          metadata: { phase, empty: true },
        });
      }

      continue;
    }

    if (item.type === 'reasoning') {
      const text = extractReasoningContent(item);
      events.push({
        kind: 'reasoning',
        sourceIndex,
        date,
        text,
        metadata: {
          encrypted: Boolean(typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0),
          sourceType: 'reasoning',
        },
      });
      continue;
    }

    if (isToolCallType(item.type)) {
      events.push({
        kind: 'tool_call',
        sourceIndex,
        date,
        callId: typeof item.call_id === 'string' ? item.call_id : undefined,
        toolName: extractToolName(item),
        inputText: extractToolInput(item),
        metadata: {
          sourceType: item.type,
          isSubagent: isSubagentTool(extractToolName(item)),
        },
      });
      continue;
    }

    if (isToolOutputType(item.type)) {
      events.push({
        kind: 'tool_output',
        sourceIndex,
        date,
        callId: typeof item.call_id === 'string' ? item.call_id : undefined,
        text: extractToolOutput(item),
        metadata: {
          sourceType: item.type,
        },
      });
    }
  }

  return dedupeEvents(events);
}

function buildIncrementalTurn(
  events: CodexNormalizedEvent[],
  effectiveSourceIndex: number,
  effectiveHistoryIndex: number
): CodexConversationTurn | null {
  const firstNewEvent = events.find(event => event.sourceIndex > effectiveSourceIndex);
  if (!firstNewEvent) {
    return null;
  }

  const userEvents = events.filter(event => event.kind === 'user_prompt');

  let userEvent: CodexNormalizedEvent | undefined;
  let historyIndex = effectiveHistoryIndex;
  let isTurnContinuation = false;

  if (firstNewEvent.kind === 'user_prompt') {
    userEvent = firstNewEvent;
    historyIndex = effectiveHistoryIndex + 1;
  } else {
    for (let index = userEvents.length - 1; index >= 0; index -= 1) {
      const candidate = userEvents[index];
      if (candidate.sourceIndex < firstNewEvent.sourceIndex) {
        userEvent = candidate;
        break;
      }
    }

    if (!userEvent || effectiveHistoryIndex < 0) {
      return null;
    }

    historyIndex = effectiveHistoryIndex;
    isTurnContinuation = true;
  }

  const nextUserEvent = userEvents.find(event => event.sourceIndex > userEvent.sourceIndex);
  const turnEndExclusive = nextUserEvent?.sourceIndex ?? Number.MAX_SAFE_INTEGER;
  const turnEvents = events.filter(event =>
    event.sourceIndex >= userEvent.sourceIndex &&
    event.sourceIndex < turnEndExclusive
  );

  const hasNewFinalAnswer = turnEvents.some(event =>
    event.kind === 'assistant_final' && event.sourceIndex > effectiveSourceIndex
  );
  const shouldEmitUser = userEvent.sourceIndex > effectiveSourceIndex;

  if (!shouldEmitUser && !hasNewFinalAnswer) {
    return null;
  }

  return {
    user: userEvent,
    events: turnEvents,
    historyIndex,
    isTurnContinuation,
  };
}

function turnToHistory(turn: CodexConversationTurn, effectiveSourceIndex: number): any[] {
  const history: any[] = [];
  const finalAssistant = getFinalAssistant(turn.events);

  if (turn.user.sourceIndex > effectiveSourceIndex) {
    history.push({
      role: 'User',
      message: turn.user.text,
      message_raw: turn.user.text,
      date: turn.user.date,
      history_index: turn.historyIndex,
      file_names: [],
    });
  }

  if (finalAssistant && finalAssistant.sourceIndex > effectiveSourceIndex) {
    const thoughts = buildThoughts(turn.events, turn.historyIndex);
    history.push({
      role: 'Assistant',
      message: finalAssistant.text,
      message_raw: finalAssistant.text,
      date: finalAssistant.date,
      history_index: turn.historyIndex,
      response_time: calculateResponseTime(turn.user.date, finalAssistant.date),
      assistant_id: CODEMIE_ASSISTANT_ID,
      thoughts: thoughts.length > 0 ? thoughts : undefined,
    });
  }

  return history;
}

function buildThoughts(events: CodexNormalizedEvent[], historyIndex: number): CodexToolThought[] {
  const thoughts: CodexToolThought[] = [];
  const toolThoughtByCallId = new Map<string, CodexToolThought>();

  for (const event of events) {
    if (event.kind === 'user_prompt' || event.kind === 'assistant_final') {
      continue;
    }

    if (event.kind === 'assistant_commentary' || event.kind === 'assistant_other') {
      if (!event.text?.trim()) {
        continue;
      }

      thoughts.push({
        id: `codex-commentary-${historyIndex}-${event.sourceIndex}`,
        parent_id: null,
        metadata: {
          timestamp: event.date,
          source_index: event.sourceIndex,
          event_kind: event.kind,
          ...(event.metadata ?? {}),
        },
        in_progress: false,
        input_text: '',
        message: event.text,
        author_type: 'Agent',
        author_name: 'Codex Commentary',
        output_format: 'text',
        error: false,
        interrupted: false,
        aborted: false,
        children: [],
      });
      continue;
    }

    if (event.kind === 'reasoning') {
      thoughts.push({
        id: `codex-reasoning-${historyIndex}-${event.sourceIndex}`,
        parent_id: null,
        metadata: {
          timestamp: event.date,
          source_index: event.sourceIndex,
          event_kind: event.kind,
          ...(event.metadata ?? {}),
        },
        in_progress: false,
        input_text: '',
        message: event.text || '[reasoning]',
        author_type: 'Agent',
        author_name: 'Codex Reasoning',
        output_format: 'text',
        error: false,
        interrupted: false,
        aborted: false,
        children: [],
      });
      continue;
    }

    if (event.kind === 'tool_call') {
      const thought: CodexToolThought = {
        id: event.callId || `codex-tool-${historyIndex}-${event.sourceIndex}`,
        parent_id: null,
        metadata: {
          timestamp: event.date,
          source_index: event.sourceIndex,
          event_kind: event.kind,
          call_id: event.callId,
          ...(event.metadata ?? {}),
        },
        in_progress: false,
        input_text: event.inputText || '',
        message: '',
        author_type: isSubagentTool(event.toolName) ? 'Agent' : 'Tool',
        author_name: event.toolName || 'Unknown Tool',
        output_format: 'text',
        error: false,
        interrupted: false,
        aborted: false,
        children: [],
      };

      thoughts.push(thought);
      if (event.callId) {
        toolThoughtByCallId.set(event.callId, thought);
      }
      continue;
    }

    if (event.kind === 'tool_output') {
      const existingThought = event.callId ? toolThoughtByCallId.get(event.callId) : undefined;
      if (existingThought) {
        existingThought.message = event.text || '';
        existingThought.metadata = {
          ...existingThought.metadata,
          output_source_index: event.sourceIndex,
          output_timestamp: event.date,
        };
      } else {
        thoughts.push({
          id: event.callId || `codex-tool-output-${historyIndex}-${event.sourceIndex}`,
          parent_id: null,
          metadata: {
            timestamp: event.date,
            source_index: event.sourceIndex,
            event_kind: event.kind,
            call_id: event.callId,
            ...(event.metadata ?? {}),
          },
          in_progress: false,
          input_text: '',
          message: event.text || '',
          author_type: 'Tool',
          author_name: 'Unknown Tool',
          output_format: 'text',
          error: false,
          interrupted: false,
          aborted: false,
          children: [],
        });
      }
    }
  }

  return thoughts;
}

function getFinalAssistant(events: CodexNormalizedEvent[]): CodexNormalizedEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].kind === 'assistant_final') {
      return events[index];
    }
  }
  return undefined;
}

function dedupeEvents(events: CodexNormalizedEvent[]): CodexNormalizedEvent[] {
  const seen = new Set<string>();
  const deduped: CodexNormalizedEvent[] = [];

  for (const event of events) {
    const key = [
      event.kind,
      event.sourceIndex,
      event.callId ?? '',
      event.toolName ?? '',
      event.text ?? '',
      event.inputText ?? '',
    ].join('|');

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(event);
  }

  return deduped;
}

function isToolCallType(type: string): boolean {
  return type === 'function_call' || type === 'custom_tool_call' || type === 'web_search_call';
}

function isToolOutputType(type: string): boolean {
  return type === 'function_call_output' || type === 'custom_tool_call_output';
}

function extractToolName(item: CodexResponseItem & { name?: unknown; type: string }): string {
  return typeof item.name === 'string' && item.name.trim()
    ? item.name
    : item.type;
}

function extractToolInput(item: CodexResponseItem & { arguments?: unknown; input?: unknown }): string {
  if (typeof item.arguments === 'string' && item.arguments.trim()) {
    return item.arguments;
  }

  if (item.input !== undefined) {
    try {
      return typeof item.input === 'string'
        ? item.input
        : JSON.stringify(item.input);
    } catch {
      return String(item.input);
    }
  }

  return '';
}

function extractToolOutput(item: CodexResponseItem & { output?: unknown }): string {
  if (typeof item.output === 'string' && item.output.trim()) {
    return item.output;
  }

  if (item.output !== undefined) {
    try {
      return typeof item.output === 'string'
        ? item.output
        : JSON.stringify(item.output);
    } catch {
      return String(item.output);
    }
  }

  return extractMessageContent(item) || '';
}

function extractReasoningContent(item: {
  summary?: unknown;
  content?: unknown;
}): string | undefined {
  if (Array.isArray(item.summary)) {
    const summaryText = item.summary
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') {
          const text = (entry as { text?: unknown }).text;
          if (typeof text === 'string') return text;
        }
        return undefined;
      })
      .filter((entry): entry is string => Boolean(entry?.trim()))
      .join('\n');

    if (summaryText.trim()) {
      return summaryText;
    }
  }

  if (typeof item.summary === 'string' && item.summary.trim()) {
    return item.summary;
  }

  if (typeof item.content === 'string' && item.content.trim()) {
    return item.content;
  }

  return undefined;
}

function isSubagentTool(toolName?: string): boolean {
  if (!toolName) {
    return false;
  }

  return [
    'spawn_agent',
    'send_input',
    'wait_agent',
    'resume_agent',
    'close_agent',
  ].includes(toolName);
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

function extractMessageContent(item: CodexResponseItem & { content?: unknown }): string | undefined {
  if (typeof item.output === 'string' && item.output.trim()) {
    return item.output;
  }

  const maybeContent = item.content;
  if (typeof maybeContent === 'string' && maybeContent.trim()) {
    return maybeContent;
  }

  if (Array.isArray(maybeContent)) {
    const parts = maybeContent
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const text = (part as { text?: unknown; thinking?: unknown }).text;
          if (typeof text === 'string') return text;
          const thinking = (part as { text?: unknown; thinking?: unknown }).thinking;
          if (typeof thinking === 'string') return thinking;
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
