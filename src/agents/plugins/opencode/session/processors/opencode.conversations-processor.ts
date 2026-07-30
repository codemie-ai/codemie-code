// src/agents/plugins/opencode/session/processors/opencode.conversations-processor.ts
/**
 * OpenCode Conversations Processor
 *
 * Transforms OpenCode messages and parts into incremental CodeMie conversation
 * payloads and queues them in {sessionId}_conversation.jsonl, where the shared
 * conversation-sync processor picks them up and PUTs them to
 * /v1/conversations/{id}/history.
 *
 * Shape matches the other agents: the visible history holds the user prompt and
 * the assistant's reply, while tool calls and reasoning are attached as
 * `thoughts` on the assistant entry.
 *
 * Structurally modelled on codex.conversations-processor.ts — same checkpoint
 * sentinel, turn-continuation handling and syncUpdates contract.
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import type {
  OpenCodeMessage,
  OpenCodeAssistantMessage,
  OpenCodePart,
  OpenCodeMetadata,
} from '../../opencode-message-types.js';
import {
  isTextPart,
  isToolPart,
  isReasoningPart,
} from '../../opencode-message-types.js';
import type { ConversationPayloadRecord } from '../../../../../providers/plugins/sso/session/processors/conversations/types.js';
import { CONVERSATION_SYNC_STATUS } from '../../../../../providers/plugins/sso/session/processors/conversations/types.js';
import { CODEMIE_ASSISTANT_ID } from '../../../../../providers/plugins/sso/session/processors/conversations/constants.js';
import { getSessionConversationPath } from '../../../../core/session/session-config.js';
import { loadPartsForMessage } from '../../opencode.storage-utils.js';
import { logger } from '../../../../../utils/logger.js';

/**
 * The conversation folder these payloads are filed under in CodeMie.
 * Set explicitly so the payload does not depend on the sync processor's
 * client-type fallback, which defaults to 'Claude Desktop'.
 */
const OPENCODE_CONVERSATION_FOLDER = 'opencode';

type OpenCodeEventKind = 'user_prompt' | 'assistant_reply' | 'reasoning' | 'tool_call';

interface OpenCodeNormalizedEvent {
  kind: OpenCodeEventKind;
  /** Position in the flattened (message, part) stream — the checkpoint unit. */
  sourceIndex: number;
  date: string;
  text?: string;
  toolName?: string;
  inputText?: string;
  callId?: string;
  error?: boolean;
  model?: string;
}

interface OpenCodeConversationTurn {
  user: OpenCodeNormalizedEvent;
  events: OpenCodeNormalizedEvent[];
  historyIndex: number;
  isTurnContinuation: boolean;
}

interface OpenCodeThought {
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

export class OpenCodeConversationsProcessor implements SessionProcessor {
  readonly name = 'opencode-conversations';
  readonly priority = 2;  // Run after metrics

  shouldProcess(session: ParsedSession): boolean {
    if (process.env.CODEMIE_CONV_SYNC_DISABLED === '1') return false;
    return session.messages.length > 0;
  }

  // _context is intentionally unused: conversation identity comes from
  // session.metadata.openCodeSessionId, never from context.agentSessionId,
  // which differs between the timer/Stop and in-process SessionEnd paths.
  async process(session: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const metadata = session.metadata as (OpenCodeMetadata & { storagePath?: string }) | undefined;
      const openCodeSessionId = metadata?.openCodeSessionId;
      const storagePath = metadata?.storagePath;

      if (!openCodeSessionId || !storagePath) {
        return {
          success: false,
          message: 'Missing openCodeSessionId or storagePath in session.metadata',
          metadata: { failureReason: 'NO_OPENCODE_SESSION_ID' }
        };
      }

      const messages = session.messages as OpenCodeMessage[];
      const events = await normalizeEvents(messages, storagePath, openCodeSessionId, metadata?.partsMap);

      logger.debug(
        `[opencode-conversations] Normalised ${events.length} events from ${messages.length} messages`
      );

      if (events.length === 0) {
        return { success: true, message: 'No conversation events generated', metadata: { recordsProcessed: 0 } };
      }

      const { SessionStore } = await import('../../../../core/session/SessionStore.js');
      const sessionStore = new SessionStore();
      const sessionMetadata = await sessionStore.loadSession(session.sessionId);
      const persistedHistoryIndex = sessionMetadata?.sync?.conversations?.lastSyncedHistoryIndex ?? -1;
      const lastSyncedSourceIndex = parseLastSyncedSourceIndex(
        sessionMetadata?.sync?.conversations?.lastSyncedMessageUuid,
        persistedHistoryIndex
      );

      const conversationsPath = getSessionConversationPath(session.sessionId);
      const { readJSONL } = await import('../../../../../providers/plugins/sso/session/utils/jsonl-reader.js');
      const existingPayloads = await readJSONL<ConversationPayloadRecord>(conversationsPath);

      // Payloads already queued but not yet uploaded also advance the watermark,
      // otherwise every tick re-queues the same turn.
      const queuedCheckpoint = getQueuedCheckpoint(existingPayloads);
      const effectiveSourceIndex = Math.max(lastSyncedSourceIndex, queuedCheckpoint.sourceIndex);
      const effectiveHistoryIndex = Math.max(persistedHistoryIndex, queuedCheckpoint.historyIndex);

      const turn = buildIncrementalTurn(events, effectiveSourceIndex, effectiveHistoryIndex);

      if (!turn) {
        logger.debug(
          `[opencode-conversations] No complete turn past source index ${effectiveSourceIndex} for ${openCodeSessionId}`
        );
        return { success: true, message: 'No new conversation messages', metadata: { recordsProcessed: 0 } };
      }

      const newTurnEvents = turn.events.filter(event => event.sourceIndex > effectiveSourceIndex);
      const endSourceIndex = Math.max(...newTurnEvents.map(event => event.sourceIndex));
      const sentinel = `${openCodeSessionId}@${endSourceIndex}`;

      if (existingPayloads.some(payload => payload.lastProcessedMessageUuid === sentinel)) {
        logger.debug(`[opencode-conversations] Window ${sentinel} already queued, skipping`);
        return { success: true, message: 'Window already queued', metadata: { recordsProcessed: 0 } };
      }

      const history = turnToHistory(turn, effectiveSourceIndex);

      if (history.length === 0) {
        logger.debug(`[opencode-conversations] Turn resolved but produced no visible history for ${sentinel}`);
        return { success: true, message: 'No visible history generated', metadata: { recordsProcessed: 0 } };
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
          // Always the opencode ses_* id, never context.agentSessionId. That
          // field carries ses_* on the timer and Stop paths but the CodeMie UUID
          // on the in-process SessionEnd path, and conversationId is the PUT
          // path id — so keying off it filed a session's final turn under a
          // second conversation and split the history in two. The checkpoint
          // sentinel already keys on openCodeSessionId, so this is the identity
          // the rest of the pipeline is built around.
          conversationId: openCodeSessionId,
          assistantId: CODEMIE_ASSISTANT_ID,
          folder: OPENCODE_CONVERSATION_FOLDER,
          llmModel: resolveTurnModel(turn.events),
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
              // Same identity as payload.conversationId above — see the note there.
              conversationId: openCodeSessionId,
              totalMessagesSynced: history.length,
              totalSyncAttempts: 1,
              lastSyncAt: Date.now(),
            },
          },
        }
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[opencode-conversations] Processing failed:', error);
      return { success: false, message: `Conversations processing failed: ${errorMessage}` };
    }
  }
}

/**
 * Flatten messages and their parts into a single ordered event stream.
 *
 * `sourceIndex` counts across the flattened (message, part) sequence. OpenCode
 * only ever appends — new parts land on the newest message, new messages at the
 * end — so an index already emitted keeps its position on later ticks, which is
 * what makes it usable as a sync watermark.
 */
async function normalizeEvents(
  messages: OpenCodeMessage[],
  storagePath: string,
  openCodeSessionId: string,
  partsMap?: Record<string, OpenCodePart[]>
): Promise<OpenCodeNormalizedEvent[]> {
  const events: OpenCodeNormalizedEvent[] = [];
  let sourceIndex = 0;

  for (const message of messages) {
    const date = toIsoDate(message.time?.created);
    const parts = await loadPartsForMessage<OpenCodePart>(
      storagePath, message.id, openCodeSessionId, partsMap
    );

    if (message.role === 'user') {
      // Burn the index unconditionally, exactly as the assistant branch does.
      // A user message whose parts have not flushed yet yields no text on this
      // tick but will on the next one; consuming the index only when text is
      // present would shift every later sourceIndex by one between ticks and
      // silently move the checkpoint onto a different event.
      const index = sourceIndex++;

      const text = parts
        .filter(part => isTextPart(part) && !isIgnoredPart(part))
        .map(part => (part as { text: string }).text)
        .filter(value => value?.trim())
        .join('\n');

      if (text) {
        events.push({ kind: 'user_prompt', sourceIndex: index, date, text });
      }
      continue;
    }

    const assistant = message as OpenCodeAssistantMessage;
    // Bare model id, consistent with the metrics pipeline.
    const model = assistant.modelID?.trim() || undefined;

    for (const part of parts) {
      const index = sourceIndex++;

      if (isReasoningPart(part)) {
        if (part.text?.trim()) {
          events.push({ kind: 'reasoning', sourceIndex: index, date, text: part.text, model });
        }
        continue;
      }

      if (isToolPart(part)) {
        events.push({
          kind: 'tool_call',
          sourceIndex: index,
          date,
          callId: part.callID || part.id,
          toolName: part.tool,
          inputText: stringify(part.state.input),
          text: part.state.status === 'error'
            ? (part.state.error ?? '')
            : stringify(part.state.output),
          error: part.state.status === 'error',
          model,
        });
        continue;
      }

      if (isTextPart(part) && !isIgnoredPart(part) && part.text?.trim()) {
        events.push({ kind: 'assistant_reply', sourceIndex: index, date, text: part.text, model });
      }
    }
  }

  return events;
}

/**
 * Resolve the window of events to publish next.
 *
 * A turn runs from a user prompt to the next user prompt. When new events land
 * inside a turn that was already partially published, the turn is re-emitted as
 * a continuation under its original history index so the backend appends rather
 * than duplicating.
 */
function buildIncrementalTurn(
  events: OpenCodeNormalizedEvent[],
  effectiveSourceIndex: number,
  effectiveHistoryIndex: number
): OpenCodeConversationTurn | null {
  const firstNewEvent = events.find(event => event.sourceIndex > effectiveSourceIndex);
  if (!firstNewEvent) return null;

  const userEvents = events.filter(event => event.kind === 'user_prompt');

  let userEvent: OpenCodeNormalizedEvent | undefined;
  let historyIndex = effectiveHistoryIndex;
  let isTurnContinuation = false;

  if (firstNewEvent.kind === 'user_prompt') {
    userEvent = firstNewEvent;
    historyIndex = effectiveHistoryIndex + 1;
  } else {
    for (let index = userEvents.length - 1; index >= 0; index -= 1) {
      if (userEvents[index].sourceIndex < firstNewEvent.sourceIndex) {
        userEvent = userEvents[index];
        break;
      }
    }

    if (!userEvent || effectiveHistoryIndex < 0) return null;

    historyIndex = effectiveHistoryIndex;
    isTurnContinuation = true;
  }

  const nextUserEvent = userEvents.find(event => event.sourceIndex > userEvent.sourceIndex);
  const turnEndExclusive = nextUserEvent?.sourceIndex ?? Number.MAX_SAFE_INTEGER;
  const turnEvents = events.filter(event =>
    event.sourceIndex >= userEvent.sourceIndex && event.sourceIndex < turnEndExclusive
  );

  const hasNewReply = turnEvents.some(event =>
    event.kind === 'assistant_reply' && event.sourceIndex > effectiveSourceIndex
  );
  const shouldEmitUser = userEvent.sourceIndex > effectiveSourceIndex;

  // Hold the turn back until the assistant has actually said something —
  // publishing a prompt with no reply would leave a dangling history entry.
  if (!shouldEmitUser && !hasNewReply) return null;

  return { user: userEvent, events: turnEvents, historyIndex, isTurnContinuation };
}

function turnToHistory(
  turn: OpenCodeConversationTurn,
  effectiveSourceIndex: number
): Array<Record<string, unknown> & { role: string; history_index: number }> {
  const history: Array<Record<string, unknown> & { role: string; history_index: number }> = [];
  const finalReply = getFinalReply(turn.events);

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

  if (finalReply && finalReply.sourceIndex > effectiveSourceIndex) {
    const thoughts = buildThoughts(turn.events, turn.historyIndex);
    history.push({
      role: 'Assistant',
      message: finalReply.text,
      message_raw: finalReply.text,
      date: finalReply.date,
      history_index: turn.historyIndex,
      response_time: calculateResponseTime(turn.user.date, finalReply.date),
      assistant_id: CODEMIE_ASSISTANT_ID,
      ...(thoughts.length > 0 && { thoughts }),
    });
  }

  return history;
}

/**
 * Build the thought tree hung off the assistant entry: one node per tool call
 * (input and output together, since OpenCode keeps both on the same part) and
 * one per reasoning block.
 */
function buildThoughts(events: OpenCodeNormalizedEvent[], historyIndex: number): OpenCodeThought[] {
  const thoughts: OpenCodeThought[] = [];

  for (const event of events) {
    if (event.kind === 'user_prompt' || event.kind === 'assistant_reply') continue;

    const isTool = event.kind === 'tool_call';

    thoughts.push({
      id: isTool
        ? (event.callId || `opencode-tool-${historyIndex}-${event.sourceIndex}`)
        : `opencode-reasoning-${historyIndex}-${event.sourceIndex}`,
      parent_id: null,
      metadata: {
        timestamp: event.date,
        source_index: event.sourceIndex,
        event_kind: event.kind,
        ...(isTool && { call_id: event.callId }),
      },
      in_progress: false,
      input_text: event.inputText ?? '',
      message: event.text || (isTool ? '' : '[reasoning]'),
      author_type: isTool ? 'Tool' : 'Agent',
      author_name: isTool ? (event.toolName || 'Unknown Tool') : 'OpenCode Reasoning',
      output_format: 'text',
      error: event.error === true,
      interrupted: false,
      aborted: false,
      children: [],
    });
  }

  return thoughts;
}

function getFinalReply(events: OpenCodeNormalizedEvent[]): OpenCodeNormalizedEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].kind === 'assistant_reply') return events[index];
  }
  return undefined;
}

function resolveTurnModel(events: OpenCodeNormalizedEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].model) return events[index].model;
  }
  return undefined;
}

/** Parts OpenCode marks as ignored or synthetic are not user-authored content. */
function isIgnoredPart(part: OpenCodePart): boolean {
  const flags = part as { ignored?: boolean; synthetic?: boolean };
  return flags.ignored === true || flags.synthetic === true;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toIsoDate(timestamp: number | undefined): string {
  return new Date(typeof timestamp === 'number' && timestamp > 0 ? timestamp : Date.now()).toISOString();
}

function parseLastSyncedSourceIndex(value: unknown, fallback: number): number {
  if (typeof value === 'string') {
    const index = Number.parseInt(value.slice(value.lastIndexOf('@') + 1), 10);
    if (Number.isFinite(index)) return index;
  }
  return fallback;
}

function getQueuedCheckpoint(
  payloads: ConversationPayloadRecord[]
): { sourceIndex: number; historyIndex: number } {
  let sourceIndex = -1;
  let historyIndex = -1;

  for (const payload of payloads) {
    sourceIndex = Math.max(sourceIndex, parseLastSyncedSourceIndex(payload.lastProcessedMessageUuid, -1));
    if (payload.historyIndices.length > 0) {
      historyIndex = Math.max(historyIndex, Math.max(...payload.historyIndices));
    }
  }

  return { sourceIndex, historyIndex };
}

function calculateResponseTime(start: string, end: string): number | undefined {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return undefined;
  return Math.max(0, Math.round(((endMs - startMs) / 1000) * 100) / 100);
}
