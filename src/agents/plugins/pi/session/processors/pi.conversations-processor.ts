/**
 * Pi Conversations Processor
 *
 * Turns Pi's v3 JSONL entry tree into incremental CodeMie conversation payloads so a Pi
 * run shows up in the conversations UI the same way Claude, Codex, OpenCode and Gemini
 * runs do.
 *
 * What survives the translation:
 * - user prompts (with Pi's `<skill …>` wrapper stripped, and a wordless prompt described
 *   by what it did carry rather than dropped — see `describeUserPrompt`)
 * - the last assistant text of a turn as the visible reply; earlier ones as thoughts
 * - thinking blocks as reasoning thoughts
 * - toolCall/toolResult pairs as Tool thoughts
 * - `!`-style bash executions, unless the user marked them private (`!!`)
 * - compaction and branch summaries as summary thoughts
 *
 * What deliberately does not: anything on an abandoned branch. A Pi session file is an
 * append-only *tree*, so a `/rewind` or an edited message leaves the discarded exchange
 * in the file forever; only the active branch is uploaded.
 */

import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { SessionProcessor, ProcessingContext, ProcessingResult } from '@/agents/core/session/BaseProcessor.js';
import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import type { ConversationPayloadRecord } from '@/providers/plugins/sso/session/processors/conversations/types.js';
import { CONVERSATION_SYNC_STATUS } from '@/providers/plugins/sso/session/processors/conversations/types.js';
import { CODEMIE_ASSISTANT_ID } from '@/providers/plugins/sso/session/processors/conversations/constants.js';
import { getSessionConversationPath } from '@/agents/core/session/session-config.js';
import { readJSONL } from '@/providers/plugins/sso/session/utils/jsonl-reader.js';
import { logger } from '@/utils/logger.js';
import {
  extractPiToolCalls,
  isPiAssistantMessage,
  isPiBashExecutionMessage,
  isPiMessageEntry,
  isPiToolResultMessage,
  isPiUserMessage,
  type PiAssistantMessage,
  type PiBashExecutionMessage,
  type PiEntry,
} from '../../pi.types.js';
import { parseSkillWrapper } from '../pi-named-invocations.js';

const PI_CONVERSATIONS_PROCESSOR_NAME = 'pi-conversations';
const PI_CONVERSATION_FOLDER = 'pi';

/** Caps on what a single thought contributes to the PUT body. */
const MAX_TOOL_INPUT_CHARS = 4_000;
const MAX_TOOL_OUTPUT_CHARS = 8_000;

/**
 * Stand-in prompt for a skill invocation whose wrapper `parseSkillWrapper` refused to parse.
 *
 * That parser is fail-closed: when Pi changes the wrapper's shape it returns no name and no
 * text rather than risk handing back the skill file's body. The invocation still happened and
 * still opened a turn, so it is reported without a name instead of vanishing.
 */
const UNNAMED_SKILL_PROMPT = '/skill';

type PiEventKind =
  | 'user_prompt'
  | 'assistant_text'
  | 'thinking'
  | 'tool_call'
  | 'tool_output'
  | 'bash_execution'
  | 'summary';

interface PiNormalizedEvent {
  kind: PiEventKind;
  /** Index of the originating entry in the transcript's entry array. */
  sourceIndex: number;
  date: string;
  text?: string;
  callId?: string;
  authorName?: string;
  inputText?: string;
  error?: boolean;
  metadata?: Record<string, unknown>;
}

/** One entry of the active branch, tagged with its position in the file. */
interface PiActiveEntry {
  entry: PiEntry;
  sourceIndex: number;
}

interface PiConversationTurn {
  user: PiNormalizedEvent;
  events: PiNormalizedEvent[];
  historyIndex: number;
  isTurnContinuation: boolean;
}

/** What the scan found at the cursor: a turn to upload, a stretch to step over, or the end. */
type PiTurnScan =
  | { kind: 'done' }
  | { kind: 'skip'; resumeSourceIndex: number }
  | { kind: 'turn'; turn: PiConversationTurn };

interface PiThought {
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

export class PiConversationsProcessor implements SessionProcessor {
  readonly name = PI_CONVERSATIONS_PROCESSOR_NAME;
  readonly priority = 2;

  shouldProcess(session: ParsedSession): boolean {
    if (process.env.CODEMIE_CONV_SYNC_DISABLED === '1') return false;
    return session.messages.length > 0;
  }

  async process(session: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const metadata = session.metadata as { agentSessionId?: string; createdAt?: string } | undefined;

      // One conversation per transcript, keyed by the transcript's own header id. There is
      // no usable fallback: the run's `agentSessionId` and the CodeMie `sessionId` are both
      // shared by every transcript a run produces, so using either would merge two
      // conversations into one and interleave their history indices. A transcript that
      // cannot name itself is declined instead.
      const conversationId = typeof metadata?.agentSessionId === 'string' ? metadata.agentSessionId.trim() : '';
      if (!conversationId) {
        logger.warn(
          `[${PI_CONVERSATIONS_PROCESSOR_NAME}] Skipping a transcript of session ${session.sessionId}: ` +
            'its header carries no Pi session id, so its turns cannot be filed under a conversation of their own'
        );
        return {
          success: true,
          message: 'Skipped: transcript has no Pi session id',
          metadata: { recordsProcessed: 0, skipReason: 'MISSING_CONVERSATION_ID' },
        };
      }

      const entries = session.messages as PiEntry[];
      const activeEntries = selectActiveBranch(entries);
      const fallbackDate = metadata?.createdAt ?? new Date().toISOString();
      const events = normalizeEntries(activeEntries, fallbackDate);

      logger.debug(
        `[${PI_CONVERSATIONS_PROCESSOR_NAME}] Normalised ${events.length} events from ` +
          `${activeEntries.length} active entries of ${entries.length}`
      );

      if (events.length === 0) {
        return {
          success: true,
          message: 'No conversation events generated',
          metadata: { recordsProcessed: 0 },
        };
      }

      const conversationsPath = getSessionConversationPath(session.sessionId);
      const existingPayloads = await readJSONL<ConversationPayloadRecord>(conversationsPath);
      const syncedSourceIndex = await this.resolveSyncedSourceIndex(
        session.sessionId,
        conversationId,
        existingPayloads
      );

      const queuedSentinels = new Set(
        existingPayloads
          .map((payload) => payload.lastProcessedMessageUuid)
          .filter((sentinel): sentinel is string => typeof sentinel === 'string')
      );

      const llmModel = resolveModel(activeEntries);
      const written = await this.appendTurnPayloads({
        events,
        syncedSourceIndex,
        conversationId,
        conversationsPath,
        queuedSentinels,
        llmModel,
      });

      if (written.payloads === 0) {
        return {
          success: true,
          message: 'No new conversation messages',
          metadata: { recordsProcessed: 0 },
        };
      }

      return {
        success: true,
        message: `Generated ${written.payloads} conversation payload(s) from ${written.events} new events`,
        metadata: {
          recordsProcessed: written.events,
          userMessages: written.userMessages,
          assistantMessages: written.assistantMessages,
          syncUpdates: {
            conversations: {
              lastSyncedMessageUuid: written.lastSentinel,
              lastSyncedHistoryIndex: written.lastHistoryIndex,
              conversationId,
              totalMessagesSynced: written.userMessages + written.assistantMessages,
              totalSyncAttempts: 1,
              lastSyncAt: Date.now(),
            },
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[${PI_CONVERSATIONS_PROCESSOR_NAME}] Processing failed:`, error);
      return {
        success: false,
        message: `Conversations processing failed: ${message}`,
        metadata: { failureReason: 'PROCESSING_ERROR' },
      };
    }
  }

  /**
   * The file position this conversation's sync reached.
   *
   * Both the persisted session state and the queued payload file are shared by every
   * transcript of the run, so a checkpoint only counts when its sentinel names *this*
   * conversation — otherwise a `/new` transcript would inherit the previous one's position
   * and silently skip its own opening turns.
   *
   * Only the position is taken from state. `lastSyncedHistoryIndex` deliberately is not:
   * the sync processor computes it as a maximum over the payloads of *all* conversations
   * in the session and the session store then keeps it monotonic, so it says nothing about
   * where one conversation is. Turn numbering comes from the transcript instead
   * (see `scanNextTurn`).
   */
  private async resolveSyncedSourceIndex(
    sessionId: string,
    conversationId: string,
    existingPayloads: ConversationPayloadRecord[]
  ): Promise<number> {
    let sourceIndex = -1;

    const { SessionStore } = await import('@/agents/core/session/SessionStore.js');
    const sessionMetadata = await new SessionStore().loadSession(sessionId);
    const persisted = sessionMetadata?.sync?.conversations;
    if (persisted && belongsToConversation(persisted.lastSyncedMessageUuid, conversationId)) {
      sourceIndex = parseSentinelIndex(persisted.lastSyncedMessageUuid);
    }

    for (const payload of existingPayloads) {
      if (!belongsToConversation(payload.lastProcessedMessageUuid, conversationId)) continue;
      sourceIndex = Math.max(sourceIndex, parseSentinelIndex(payload.lastProcessedMessageUuid));
    }

    return sourceIndex;
  }

  /**
   * Queue one payload per complete turn past the checkpoint.
   *
   * Pi only fires SessionStart and SessionEnd, so a run's whole backlog arrives in a
   * single call. Emitting one window per call — as the per-turn-hooked agents can
   * afford to — would strand every turn but the first.
   */
  private async appendTurnPayloads(options: {
    events: PiNormalizedEvent[];
    syncedSourceIndex: number;
    conversationId: string;
    conversationsPath: string;
    queuedSentinels: Set<string>;
    llmModel?: string;
  }): Promise<{
    payloads: number;
    events: number;
    userMessages: number;
    assistantMessages: number;
    lastSentinel?: string;
    lastHistoryIndex?: number;
  }> {
    const { events, conversationId, conversationsPath, queuedSentinels, llmModel } = options;
    let cursorSourceIndex = options.syncedSourceIndex;

    let payloads = 0;
    let newEvents = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let lastSentinel: string | undefined;
    let lastHistoryIndex: number | undefined;
    let directoryReady = false;
    /** Summaries the cursor has passed without uploading; they ride with the next payload. */
    let carriedSummaries: PiNormalizedEvent[] = [];

    for (;;) {
      const scan = scanNextTurn(events, cursorSourceIndex);
      if (scan.kind === 'done') break;

      if (scan.kind === 'skip') {
        carriedSummaries = [
          ...carriedSummaries,
          ...summariesUpTo(events, cursorSourceIndex, scan.resumeSourceIndex),
        ];
        cursorSourceIndex = scan.resumeSourceIndex;
        continue;
      }

      const leadingSummaries = [
        ...carriedSummaries,
        ...summariesUpTo(events, cursorSourceIndex, scan.turn.user.sourceIndex),
      ];
      const turn: PiConversationTurn =
        leadingSummaries.length > 0
          ? { ...scan.turn, events: [...leadingSummaries, ...scan.turn.events] }
          : scan.turn;

      const turnEvents = turn.events.filter((event) => event.sourceIndex > cursorSourceIndex);
      if (turnEvents.length === 0) break;

      const endSourceIndex = Math.max(...turnEvents.map((event) => event.sourceIndex));
      // The cursor must strictly advance, or the loop below never terminates.
      if (endSourceIndex <= cursorSourceIndex) break;

      const sentinel = `${conversationId}@${endSourceIndex}`;
      const history = queuedSentinels.has(sentinel) ? [] : turnToHistory(turn, cursorSourceIndex);

      if (history.length > 0) {
        if (!directoryReady) {
          await mkdir(dirname(conversationsPath), { recursive: true });
          directoryReady = true;
        }

        const payloadRecord: ConversationPayloadRecord = {
          payloadId: sentinel,
          timestamp: Date.now(),
          isTurnContinuation: turn.isTurnContinuation,
          historyIndices: history.map((entry) => entry.history_index),
          messageCount: history.length,
          lastProcessedMessageUuid: sentinel,
          payload: {
            conversationId,
            assistantId: CODEMIE_ASSISTANT_ID,
            folder: PI_CONVERSATION_FOLDER,
            llmModel,
            history,
          },
          status: CONVERSATION_SYNC_STATUS.PENDING,
        };

        await appendFile(conversationsPath, JSON.stringify(payloadRecord) + '\n', 'utf-8');
        queuedSentinels.add(sentinel);

        payloads += 1;
        newEvents += turnEvents.length;
        userMessages += history.filter((entry) => entry.role === 'User').length;
        assistantMessages += history.filter((entry) => entry.role === 'Assistant').length;
        lastSentinel = sentinel;
        lastHistoryIndex = turn.historyIndex;
        carriedSummaries = [];
      }

      cursorSourceIndex = endSourceIndex;
    }

    return { payloads, events: newEvents, userMessages, assistantMessages, lastSentinel, lastHistoryIndex };
  }
}

/**
 * The entries on the active branch, in file order, each tagged with its file position.
 *
 * A Pi session file is an append-only tree: `branch()` moves the leaf back without
 * touching what is already written, so every `/rewind` and every edited message leaves
 * its abandoned exchange in the file. Reading the file as a flat log would upload
 * prompts and answers the user explicitly took back, so the active path is rebuilt the
 * way Pi itself does — from the leaf up through `parentId`.
 *
 * `sourceIndex` stays the position in the *file*, never in the path: the file is
 * append-only, so those positions are stable across runs and safe to checkpoint on.
 *
 * @see buildSessionPath in packages/coding-agent/src/core/session-manager.ts (Pi repo)
 */
function selectActiveBranch(entries: PiEntry[]): PiActiveEntry[] {
  const byId = new Map<string, PiActiveEntry>();
  let leaf: PiActiveEntry | undefined;

  for (const [sourceIndex, entry] of entries.entries()) {
    // The `session` header line is not part of the tree — upstream drops it too.
    if (!entry || typeof entry !== 'object' || entry.type === 'session') continue;
    // Only tree nodes may become the leaf. Transcripts written before CodeMie stopped
    // appending its `codemie_session_start` ownership marker still end with one, and foreign
    // tooling may append too. Such a line carries no `id`, so taking it as the leaf ended the
    // parent walk on its first step and normalised the whole conversation down to nothing.
    if (typeof entry.id !== 'string' || !entry.id) continue;
    const node: PiActiveEntry = { entry, sourceIndex };
    byId.set(entry.id, node);
    // Pi appends every entry as a child of the current leaf, so the last one written is it.
    leaf = node;
  }

  const path: PiActiveEntry[] = [];
  const visited = new Set<string>();
  let current = leaf;
  while (current) {
    path.push(current);
    const { id, parentId } = current.entry as { id?: unknown; parentId?: unknown };
    // Pi never writes a cycle, but this reads a third-party file: a corrupt or
    // hand-edited parent chain must end the walk, not spin it.
    if (typeof id === 'string') visited.add(id);
    current = typeof parentId === 'string' && !visited.has(parentId) ? byId.get(parentId) : undefined;
  }

  return path.reverse();
}

function normalizeEntries(activeEntries: PiActiveEntry[], fallbackDate: string): PiNormalizedEvent[] {
  const events: PiNormalizedEvent[] = [];

  for (const { entry, sourceIndex } of activeEntries) {
    const date = resolveEntryDate(entry, fallbackDate);

    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      const summary = (entry as { summary?: unknown }).summary;
      if (typeof summary === 'string' && summary.trim()) {
        events.push({
          kind: 'summary',
          sourceIndex,
          date,
          text: truncate(summary, MAX_TOOL_OUTPUT_CHARS),
          authorName: entry.type === 'compaction' ? 'Compaction Summary' : 'Branch Summary',
          metadata: { entry_type: entry.type },
        });
      }
      continue;
    }

    if (!isPiMessageEntry(entry)) continue;
    const message = entry.message;

    if (isPiUserMessage(message)) {
      // Every user message opens a turn, whatever it carried. Emitting the event only for
      // messages that still had words after the skill wrapper came off used to merge the
      // wordless one into the turn before it, which published the next answer under the
      // previous question.
      events.push({ kind: 'user_prompt', sourceIndex, date, text: describeUserPrompt(message.content) });
      continue;
    }

    if (isPiAssistantMessage(message)) {
      events.push(...normalizeAssistantContent(message, sourceIndex, date));
      continue;
    }

    if (isPiToolResultMessage(message)) {
      events.push({
        kind: 'tool_output',
        sourceIndex,
        date,
        callId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
        authorName: typeof message.toolName === 'string' ? message.toolName : undefined,
        text: truncate(joinTextParts(message.content), MAX_TOOL_OUTPUT_CHARS),
        error: message.isError === true,
      });
      continue;
    }

    if (isPiBashExecutionMessage(message)) {
      const bashEvent = normalizeBashExecution(message, sourceIndex, date);
      if (bashEvent) events.push(bashEvent);
    }
  }

  return events;
}

function normalizeAssistantContent(
  message: PiAssistantMessage,
  sourceIndex: number,
  date: string
): PiNormalizedEvent[] {
  if (!Array.isArray(message.content)) return [];

  // Tool calls come from the shared normalizer, so this processor accepts exactly the
  // serializations the metrics processor does. It returns them in content order, so
  // walking both lists in lockstep keeps thoughts in the order Pi emitted them.
  const toolCalls = extractPiToolCalls(message);
  let nextToolCall = 0;

  const events: PiNormalizedEvent[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== 'object') continue;
    const typed = part as { type?: unknown; text?: unknown; thinking?: unknown; toolCall?: unknown };

    const toolCall = toolCalls[nextToolCall];
    if (toolCall && (toolCall === part || toolCall === typed.toolCall)) {
      nextToolCall += 1;
      events.push({
        kind: 'tool_call',
        sourceIndex,
        date,
        callId: toolCall.id,
        authorName: toolCall.name,
        inputText: truncate(stringifyToolArguments(toolCall.arguments), MAX_TOOL_INPUT_CHARS),
      });
      continue;
    }

    if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim()) {
      events.push({ kind: 'assistant_text', sourceIndex, date, text: typed.text });
      continue;
    }

    if (typed.type === 'thinking' && typeof typed.thinking === 'string' && typed.thinking.trim()) {
      events.push({ kind: 'thinking', sourceIndex, date, text: typed.thinking });
    }
  }

  return events;
}

/**
 * A `!` bash execution becomes a Tool thought. A `!!` one becomes nothing at all:
 * Pi keeps that output out of the model's context precisely because the user does not
 * want it shared, so it must not reach CodeMie either.
 */
function normalizeBashExecution(
  message: PiBashExecutionMessage,
  sourceIndex: number,
  date: string
): PiNormalizedEvent | undefined {
  if (message.excludeFromContext === true) {
    logger.debug(
      `[${PI_CONVERSATIONS_PROCESSOR_NAME}] Skipping bash execution marked excludeFromContext at entry ${sourceIndex}`
    );
    return undefined;
  }

  const command = typeof message.command === 'string' ? message.command : '';
  const output = typeof message.output === 'string' ? message.output : '';
  if (!command && !output) return undefined;

  const exitCode = typeof message.exitCode === 'number' ? message.exitCode : undefined;
  return {
    kind: 'bash_execution',
    sourceIndex,
    date,
    authorName: 'bash',
    inputText: truncate(command, MAX_TOOL_INPUT_CHARS),
    text: truncate(output, MAX_TOOL_OUTPUT_CHARS),
    error: message.cancelled === true || (exitCode !== undefined && exitCode !== 0),
    metadata: { ...(exitCode !== undefined && { exit_code: exitCode }) },
  };
}

/**
 * What to do at `cursorSourceIndex`: upload a turn, step over a stretch that carries
 * nothing to upload, or stop.
 *
 * A turn is one user prompt and everything that followed it. Its `historyIndex` is the
 * prompt's ordinal on the *active branch* — derived from the transcript itself so that
 * numbering cannot drift with cross-conversation sync state, and so that re-processing a
 * transcript always lands each turn on the same index.
 *
 * Because the ordinal counts the active branch, a `/rewind` makes it go backwards: the
 * replacement turn takes the index of the exchange it replaced, so a later call can queue a
 * second payload carrying an already-used index. That is deliberate. The uploaded
 * conversation is meant to be the branch the user kept, and re-using the index is the only
 * way to say "this exchange took the place of that one" through a `history_index`; a
 * monotonic counter would instead publish the rewound exchange and its replacement
 * side by side, a conversation that never happened. Whether CodeMie's upsert then repairs
 * the row or appends a duplicate is a backend property this repo cannot see — see the
 * `/rewind` test in `__tests__/pi.conversations-processor.test.ts`, which pins the choice.
 * Rewinding past more turns than the replacement supplies still strands the extra rows.
 */
function scanNextTurn(events: PiNormalizedEvent[], cursorSourceIndex: number): PiTurnScan {
  const firstNewEvent = events.find((event) => event.sourceIndex > cursorSourceIndex);
  if (!firstNewEvent) return { kind: 'done' };

  const userEvents = events.filter((event) => event.kind === 'user_prompt');
  const userEvent =
    lastUserEventUpTo(userEvents, firstNewEvent.sourceIndex) ??
    // Nothing before the new events opened a turn — a transcript that starts with a
    // compaction summary, say. Resume at the next prompt rather than stalling the stream.
    userEvents.find((event) => event.sourceIndex > cursorSourceIndex);
  if (!userEvent) return { kind: 'done' };

  const nextUserEvent = userEvents.find((event) => event.sourceIndex > userEvent.sourceIndex);
  const turnEndExclusive = nextUserEvent?.sourceIndex ?? Number.MAX_SAFE_INTEGER;
  const turnEvents = events.filter(
    (event) => event.sourceIndex >= userEvent.sourceIndex && event.sourceIndex < turnEndExclusive
  );

  const isTurnContinuation = userEvent.sourceIndex <= cursorSourceIndex;
  const hasNewAssistantText = turnEvents.some(
    (event) => event.kind === 'assistant_text' && event.sourceIndex > cursorSourceIndex
  );

  if (isTurnContinuation && !hasNewAssistantText) {
    // The tail of an already-uploaded turn brought no new answer — a model turn that only
    // called tools, which is what an interrupted run usually ends on. A payload hangs its
    // thoughts off an assistant message, and this stretch has none, so its events (tool
    // calls, their results, any thinking) are dropped rather than published under an empty
    // answer. Every later turn must still be reached, so step over it instead of ending the
    // stream; summaries in the stretch are the exception and ride along with the next
    // payload (see `carriedSummaries` in `appendTurnPayloads`).
    const resumeSourceIndex = Math.max(...turnEvents.map((event) => event.sourceIndex));
    return resumeSourceIndex > cursorSourceIndex ? { kind: 'skip', resumeSourceIndex } : { kind: 'done' };
  }

  return {
    kind: 'turn',
    turn: {
      user: userEvent,
      events: turnEvents,
      historyIndex: userEvents.indexOf(userEvent),
      isTurnContinuation,
    },
  };
}

/** Summary events in `(afterExclusive, throughInclusive]`, in file order. */
function summariesUpTo(
  events: PiNormalizedEvent[],
  afterExclusive: number,
  throughInclusive: number
): PiNormalizedEvent[] {
  return events.filter(
    (event) =>
      event.kind === 'summary' &&
      event.sourceIndex > afterExclusive &&
      event.sourceIndex <= throughInclusive
  );
}

function turnToHistory(turn: PiConversationTurn, cursorSourceIndex: number): any[] {
  const history: any[] = [];
  const finalAssistant = lastEventOfKind(turn.events, 'assistant_text');

  // A prompt that describes nothing at all still opened the turn — that is why the event
  // exists — but there is no message to publish for it, so the turn goes out with only its
  // answer rather than with an empty User bubble.
  if (turn.user.sourceIndex > cursorSourceIndex && turn.user.text) {
    history.push({
      role: 'User',
      message: turn.user.text,
      message_raw: turn.user.text,
      history_index: turn.historyIndex,
      date: turn.user.date,
      file_names: [],
    });
  }

  if (finalAssistant && finalAssistant.sourceIndex > cursorSourceIndex) {
    const thoughts = buildThoughts(turn.events, turn.historyIndex, finalAssistant);
    history.push({
      role: 'Assistant',
      message: finalAssistant.text,
      message_raw: finalAssistant.text,
      history_index: turn.historyIndex,
      date: finalAssistant.date,
      response_time: calculateResponseTime(turn.user.date, finalAssistant.date),
      assistant_id: CODEMIE_ASSISTANT_ID,
      thoughts: thoughts.length > 0 ? thoughts : undefined,
    });
  }

  return history;
}

function buildThoughts(
  events: PiNormalizedEvent[],
  historyIndex: number,
  finalAssistant: PiNormalizedEvent
): PiThought[] {
  const thoughts: PiThought[] = [];
  const toolThoughtByCallId = new Map<string, PiThought>();

  for (const event of events) {
    if (event === finalAssistant || event.kind === 'user_prompt') continue;

    if (event.kind === 'tool_output') {
      const pending = event.callId ? toolThoughtByCallId.get(event.callId) : undefined;
      if (pending) {
        pending.message = event.text ?? '';
        pending.error = event.error === true;
        pending.metadata = {
          ...pending.metadata,
          output_source_index: event.sourceIndex,
          output_timestamp: event.date,
        };
        if (event.callId) toolThoughtByCallId.delete(event.callId);
        continue;
      }
    }

    const thought = createThought(event, historyIndex);
    thoughts.push(thought);
    if (event.kind === 'tool_call' && event.callId) {
      toolThoughtByCallId.set(event.callId, thought);
    }
  }

  return thoughts;
}

function createThought(event: PiNormalizedEvent, historyIndex: number): PiThought {
  const thought: PiThought = {
    id: `pi-${event.kind}-${historyIndex}-${event.sourceIndex}`,
    parent_id: null,
    metadata: {
      timestamp: event.date,
      source_index: event.sourceIndex,
      event_kind: event.kind,
      ...(event.callId && { call_id: event.callId }),
      ...(event.metadata ?? {}),
    },
    in_progress: false,
    input_text: event.inputText ?? '',
    message: event.text ?? '',
    author_type: 'Agent',
    author_name: 'Pi',
    output_format: 'text',
    error: event.error === true,
    interrupted: false,
    aborted: false,
    children: [],
  };

  switch (event.kind) {
    case 'tool_call':
    case 'tool_output':
    case 'bash_execution':
      thought.id = event.callId ?? thought.id;
      thought.author_type = 'Tool';
      thought.author_name = event.authorName ?? 'Unknown Tool';
      break;
    case 'thinking':
      thought.author_name = 'Pi Reasoning';
      break;
    case 'summary':
      thought.author_name = event.authorName ?? 'Summary';
      thought.output_format = 'summary';
      break;
    default:
      break;
  }

  return thought;
}

function lastEventOfKind(events: PiNormalizedEvent[], kind: PiEventKind): PiNormalizedEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].kind === kind) return events[index];
  }
  return undefined;
}

function lastUserEventUpTo(userEvents: PiNormalizedEvent[], sourceIndex: number): PiNormalizedEvent | undefined {
  for (let index = userEvents.length - 1; index >= 0; index -= 1) {
    if (userEvents[index].sourceIndex <= sourceIndex) return userEvents[index];
  }
  return undefined;
}

/** The model of the most recent assistant message on the branch, which is what it ran on. */
function resolveModel(activeEntries: PiActiveEntry[]): string | undefined {
  for (let index = activeEntries.length - 1; index >= 0; index -= 1) {
    const { entry } = activeEntries[index];
    if (!isPiMessageEntry(entry)) continue;
    const message = entry.message;
    if (isPiAssistantMessage(message) && typeof message.model === 'string' && message.model.trim()) {
      return message.model;
    }
  }
  return process.env.CODEMIE_MODEL || undefined;
}

/** The non-blank text blocks of a Pi message's content, in order. */
function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];

  const blocks: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.trim()) blocks.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const typed = part as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim()) {
      blocks.push(typed.text);
    }
  }
  return blocks;
}

function joinTextParts(content: unknown): string {
  return textBlocks(content).join('\n');
}

/** Image parts Pi appends after the text block when the user attaches or pastes a picture. */
function countImageParts(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (part) => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'image'
  ).length;
}

/**
 * What to publish as the user's message, given one Pi user message's content.
 *
 * Parsed one text block at a time rather than over the joined content. Blocks join with a
 * single `\n`, while `parseSkillWrapper`'s tail is anchored to the `\n\n` Pi writes after
 * `</skill>`, so parsing the joined string makes a multi-block message miss the anchored
 * match, fall through to the fail-closed opening test, and lose the whole prompt.
 *
 * A message with no words of its own still describes itself rather than returning empty:
 * `/skill:<name>` for a bare `/skill:name` invocation (upstream `_expandSkillCommand`
 * appends no tail when the command carried no arguments), an attachment count for an
 * image-only message. The skill *body* never appears — only `parseSkillWrapper`'s `name`
 * is read, and that parser is fail-closed by design.
 *
 * `piUserText` in `../pi-user-prompt.ts` does the same per-block strip for the analytics
 * session title; it stops short of naming the skill because a title has nothing to anchor.
 * The wrapper's shape itself is not restated here — `parseSkillWrapper` owns it.
 */
function describeUserPrompt(content: unknown): string {
  const words: string[] = [];
  const skillNames: string[] = [];
  let sawUnparsableWrapper = false;

  for (const block of textBlocks(content)) {
    const { name, rest } = parseSkillWrapper(block);
    if (name) skillNames.push(name);

    const text = rest.trim();
    if (text) words.push(text);
    // A non-blank block that the parser emptied without naming a skill is the fail-closed
    // path: a wrapper Pi wrote in a shape this plugin no longer recognizes.
    else if (!name && block.trim()) sawUnparsableWrapper = true;
  }

  if (words.length > 0) return words.join('\n');
  if (skillNames.length > 0) return skillNames.map((name) => `/skill:${name}`).join(' ');
  if (sawUnparsableWrapper) return UNNAMED_SKILL_PROMPT;

  const images = countImageParts(content);
  return images > 0 ? `[${images} image attachment${images === 1 ? '' : 's'}]` : '';
}

function stringifyToolArguments(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    return '';
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} characters]`;
}

function resolveEntryDate(entry: PiEntry, fallback: string): string {
  const entryTimestamp = (entry as { timestamp?: unknown }).timestamp;
  if (typeof entryTimestamp === 'string' && entryTimestamp.trim()) return entryTimestamp;

  const messageTimestamp = (entry as { message?: { timestamp?: unknown } }).message?.timestamp;
  if (typeof messageTimestamp === 'number' && Number.isFinite(messageTimestamp)) {
    return new Date(messageTimestamp).toISOString();
  }

  return fallback;
}

function calculateResponseTime(start: string, end: string): number | undefined {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return undefined;
  return Math.max(0, Math.round(((endMs - startMs) / 1000) * 100) / 100);
}

function belongsToConversation(sentinel: unknown, conversationId: string): boolean {
  return typeof sentinel === 'string' && sentinel.slice(0, sentinel.lastIndexOf('@')) === conversationId;
}

function parseSentinelIndex(sentinel: unknown): number {
  if (typeof sentinel !== 'string') return -1;
  const index = Number.parseInt(sentinel.slice(sentinel.lastIndexOf('@') + 1), 10);
  return Number.isFinite(index) ? index : -1;
}
