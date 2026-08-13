/**
 * Pi Metrics Processor
 *
 * Translates Pi session JSONL entries into MetricDelta records and writes
 * them to JSONL for eventual sync to the CodeMie API.
 *
 * The processor is re-entrant by design: the incremental-sync timer builds a fresh
 * instance every ~30 s and re-parses each transcript from the top, and the final flush
 * does it once more. Nothing durable may therefore live in an instance field — the
 * session's `{sessionId}_metrics.jsonl` is the record of what has already been reported,
 * and every quantity this processor persists is derived as an increment over it.
 */

import { readFile } from 'fs/promises';
import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import type { MetricDelta } from '../../../../core/metrics/types.js';
import type { AgentMetadata } from '../../../../core/types.js';
import { logger } from '../../../../../utils/logger.js';
import {
  extractPiToolCalls,
  isPiMessageEntry,
  isPiUserMessage,
  isPiAssistantMessage,
  isPiBashExecutionMessage,
  isPiModelChangeEntry,
  isPiToolResultMessage,
  type PiEntry,
  type PiToolCall,
  type PiToolResultMessage,
} from '../../pi.types.js';
import { extractPiFileOperation } from '../pi-file-operations.js';
import { extractPiNamedInvocations, parseSkillWrapper } from '../pi-named-invocations.js';

export const PI_METRICS_PROCESSOR_NAME = 'pi-metrics';

/** Pi's shell-escape tool name, used for `!command` entries that bypass the model. */
const BASH_TOOL = 'bash';

type PendingDelta = Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>;
type PiFileOperation = NonNullable<ReturnType<typeof extractPiFileOperation>>;

interface UnmatchedToolCall {
  entryId: string;
  toolCall: PiToolCall;
  assistantTimestamp: number;
  assistantModel?: string;
}

/**
 * The extra, Pi-specific knob this processor reads off the standard processing context.
 *
 * It is a property of the *call*, not of the processor: the same transcript is parsed by
 * a periodic tick and again by the final flush, and only the second may treat a missing
 * tool result as final.
 */
export interface PiMetricsProcessingContext extends ProcessingContext {
  /**
   * Emit tool calls that never received a result as status-less deltas. Defaults to
   * `true`, which is what the end-of-session flush wants.
   *
   * Pi persists the assistant message carrying a `toolCall` *before* running the tool, so
   * a call is unresolved for as long as it takes to run. The status-less delta claims the
   * same `${entryId}:${toolCallId}` record id the resolved delta would, and the first
   * writer wins, so a tick that emitted it would permanently erase that call's status,
   * file operations and error text. Periodic callers must therefore pass `false`; for
   * them "no result yet" is not the same observation as "no result ever".
   */
  emitUnresolvedToolCalls?: boolean;
}

/**
 * Invocation counts the run ledger observed but the transcript cannot carry.
 *
 * `/name` prompt templates are expanded into plain user text before Pi persists them, so
 * they exist only here. `/skill:name` is recorded too, as a fallback for skills whose
 * wrapper never reached the transcript.
 *
 * @see ../../pi.extension.ts — PiRunLedger
 */
export interface PiLedgerInvocations {
  commandInvocations?: Record<string, number>;
  skillCommandInvocations?: Record<string, number>;
}

/** The three per-name count maps a delta can carry, always present, possibly empty. */
interface InvocationTotals {
  skillInvocations: Record<string, number>;
  agentInvocations: Record<string, number>;
  commandInvocations: Record<string, number>;
}

/**
 * Everything the session's metrics JSONL already asserts.
 *
 * This is the processor's only durable memory. Instance fields cannot serve that role:
 * the incremental-sync timer discards the instance after every tick.
 */
interface PersistedMetrics {
  recordIds: Set<string>;
  /** Per-name counts summed across every delta already written, as the aggregator sums them. */
  invocations: InvocationTotals;
  /** Bounds of the activity already recorded; both absent when nothing is recorded. */
  activityStart?: number;
  activityEnd?: number;
}

/** Shape of an on-disk delta line, before any of its fields are trusted. */
interface RawPersistedDelta {
  recordId?: unknown;
  timestamp?: unknown;
  skillInvocations?: unknown;
  agentInvocations?: unknown;
  commandInvocations?: unknown;
}

function emptyInvocationTotals(): InvocationTotals {
  return { skillInvocations: {}, agentInvocations: {}, commandInvocations: {} };
}

/**
 * Fold ledger counts into transcript counts, keeping the larger count per name.
 *
 * The two sources observe the same events from different vantage points — one
 * `/skill:foo` produces both a ledger record and a `<skill>` wrapper — so summing would
 * double-count. Taking the maximum keeps whichever source saw more without inventing
 * invocations.
 */
function mergeInvocationCounts(base: Record<string, number>, extra?: Record<string, number>): void {
  if (!extra) return;
  for (const [name, count] of Object.entries(extra)) {
    base[name] = Math.max(base[name] ?? 0, count);
  }
}

/** Accumulate `extra` into `base`, summing per name. */
function addInvocationCounts(base: Record<string, number>, extra: Record<string, number>): void {
  for (const [name, count] of Object.entries(extra)) {
    base[name] = (base[name] ?? 0) + count;
  }
}

/**
 * The part of `total` that has not been reported yet.
 *
 * The aggregator sums these maps across deltas, so a delta must carry the *increment*
 * rather than the running total; re-emitting the total on every tick is what multiplied
 * a single `/skill:review` into one count per tick. A name whose persisted count already
 * meets the total contributes nothing, which makes any number of re-parses idempotent.
 */
function invocationIncrement(
  total: Record<string, number>,
  persisted: Record<string, number>
): Record<string, number> {
  const increment: Record<string, number> = {};
  for (const [name, count] of Object.entries(total)) {
    const remaining = count - (persisted[name] ?? 0);
    if (remaining > 0) {
      increment[name] = remaining;
    }
  }
  return increment;
}

/** Whether any of the three maps carries a count worth reporting. */
function hasInvocations(invocations: InvocationTotals): boolean {
  return Object.values(invocations).some((counts) => Object.keys(counts).length > 0);
}

/**
 * Record id for a delta that exists only to carry invocation counts.
 *
 * Such a delta has no Pi entry to name it after, so it is numbered — and numbered against
 * what the JSONL already holds, so it can never collide with a record already written.
 * Re-parsing the same batch does not produce a second one: the counts it reported are then
 * persisted, which leaves the increment empty and the carrier unneeded.
 */
function nextInvocationRecordId(sessionId: string, existingRecordIds: Set<string>): string {
  let index = 0;
  while (existingRecordIds.has(`${sessionId}:invocations:${index}`)) {
    index++;
  }
  return `${sessionId}:invocations:${index}`;
}

/** Numeric entries of an untrusted JSON value, or undefined when it is not a plain map. */
function readCountMap(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  const counts: Record<string, number> = {};
  for (const [name, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === 'number' && Number.isFinite(count)) {
      counts[name] = count;
    }
  }
  return counts;
}

export class PiMetricsProcessor implements SessionProcessor {
  readonly name = PI_METRICS_PROCESSOR_NAME;
  readonly priority = 1;

  // Tracks Pi entry ids already seen across all files in this run. /new and /fork
  // copy history into a new transcript; this set prevents double-counting.
  private readonly seenEntryIds = new Set<string>();

  // Named invocations observed across the transcripts this instance has parsed, deduped
  // by the entry-id set above. It is a running total, not a report: what actually gets
  // written is this minus whatever the JSONL already carries, so a discarded instance
  // costs nothing but a re-parse.
  private readonly runInvocations: InvocationTotals = emptyInvocationTotals();

  constructor(
    private readonly metadata: AgentMetadata | undefined = undefined,
    private readonly ledgerInvocations: PiLedgerInvocations | undefined = undefined
  ) {}

  shouldProcess(session: ParsedSession): boolean {
    return session.messages.length > 0;
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const entries = session.messages as PiEntry[];
      const persisted = await this.readPersistedMetrics(session.sessionId);
      if (persisted === undefined) {
        return {
          success: true,
          message: 'Skipping metrics processing: could not read existing deltas safely',
          metadata: { recordsProcessed: entries.length, deltasWritten: 0 },
        };
      }
      const existingRecordIds = persisted.recordIds;

      // Bound entry processing to this CodeMie run. On `--continue` / `-r` Pi appends
      // to the same transcript, so entries from earlier runs must not be re-emitted.
      const sessionStartTime = await this.getCodeMieSessionStartTime(session.sessionId, session);
      const gitBranch = context.gitBranch;
      const fallbackModel = process.env.CODEMIE_MODEL;
      const emitUnresolvedToolCalls =
        (context as PiMetricsProcessingContext).emitUnresolvedToolCalls ?? true;

      const base = (recordId: string, timestamp: number): PendingDelta => ({
        recordId,
        sessionId: session.sessionId,
        agentSessionId:
          (session.metadata as { agentSessionId?: string } | undefined)?.agentSessionId ??
          context.sessionId ??
          session.sessionId,
        timestamp,
        ...(gitBranch && { gitBranch }),
      });

      // The run's activity window, seeded from what is already on disk so it can only
      // grow. It spans every reportable in-window entry rather than only the entries
      // whose deltas are new — on a re-parse almost nothing is new, and a window built
      // from those alone collapses to the last tick's span.
      let activityStart = persisted.activityStart;
      let activityEnd = persisted.activityEnd;
      const noteActivity = (timestamp: number): void => {
        activityStart = activityStart === undefined ? timestamp : Math.min(activityStart, timestamp);
        activityEnd = activityEnd === undefined ? timestamp : Math.max(activityEnd, timestamp);
      };

      // Track unmatched assistant tool calls in insertion order. When a toolResult
      // arrives, we pair it with the most recent preceding unmatched call for that id.
      const unmatchedToolCalls: UnmatchedToolCall[] = [];
      const unmatchedById = new Map<string, UnmatchedToolCall[]>();

      const pushUnmatched = (call: UnmatchedToolCall): void => {
        unmatchedToolCalls.push(call);
        const list = unmatchedById.get(call.toolCall.id) ?? [];
        list.push(call);
        unmatchedById.set(call.toolCall.id, list);
      };

      const findAndRemoveUnmatched = (toolCallId: string): UnmatchedToolCall | undefined => {
        const list = unmatchedById.get(toolCallId);
        if (!list || list.length === 0) return undefined;
        const call = list.pop()!;
        if (list.length === 0) {
          unmatchedById.delete(toolCallId);
        }
        const index = unmatchedToolCalls.lastIndexOf(call);
        if (index !== -1) unmatchedToolCalls.splice(index, 1);
        return call;
      };

      const deltas: PendingDelta[] = [];
      // Entries that passed the dedup and run-window guards, so named invocations are
      // counted for this run only rather than for the whole (possibly resumed) transcript.
      const countedEntries: PiEntry[] = [];
      let skippedDueToDedup = 0;

      const maybePushDelta = (delta: PendingDelta): void => {
        if (existingRecordIds.has(delta.recordId)) {
          skippedDueToDedup++;
          return;
        }
        deltas.push(delta);
      };

      for (const entry of entries) {
        if (!entry.id || this.seenEntryIds.has(entry.id)) {
          continue;
        }
        this.seenEntryIds.add(entry.id);

        // A mid-session `/model` switch, so the aggregator's most-used model reflects the
        // model actually in use rather than only the one the run started with.
        if (isPiModelChangeEntry(entry)) {
          const ts = this.entryIsoTimestamp(entry.timestamp, sessionStartTime);
          if (ts < sessionStartTime) {
            continue;
          }
          noteActivity(ts);
          maybePushDelta({
            ...base(`${entry.id}:model`, ts),
            models: [entry.modelId],
          });
          continue;
        }

        if (!isPiMessageEntry(entry)) {
          continue;
        }

        const msg = entry.message;

        if (isPiUserMessage(msg)) {
          const ts = this.entryTimestamp(msg, sessionStartTime);
          if (ts < sessionStartTime) {
            continue;
          }
          noteActivity(ts);
          countedEntries.push(entry);
          const text = this.extractUserText(msg);
          if (!text) {
            continue;
          }
          const recordId = `${entry.id}:prompt`;
          maybePushDelta({
            ...base(recordId, ts),
            userPrompts: [{ count: 1, text }],
            ...(fallbackModel && { models: [fallbackModel] }),
          });
          continue;
        }

        if (isPiAssistantMessage(msg)) {
          const assistantTimestamp = this.entryTimestamp(msg, sessionStartTime);
          if (assistantTimestamp < sessionStartTime) {
            continue;
          }
          noteActivity(assistantTimestamp);
          countedEntries.push(entry);
          const assistantModel = msg.model || fallbackModel;
          const toolCalls = extractPiToolCalls(msg);

          for (const toolCall of toolCalls) {
            pushUnmatched({
              entryId: entry.id,
              toolCall,
              assistantTimestamp,
              assistantModel,
            });
          }

          if (msg.errorMessage) {
            const recordId = `${entry.id}:error`;
            maybePushDelta({
              ...base(recordId, assistantTimestamp),
              apiErrorMessage: msg.errorMessage,
              ...(assistantModel && { models: [assistantModel] }),
            });
          }
          continue;
        }

        if (isPiToolResultMessage(msg)) {
          const ts = this.entryTimestamp(msg, sessionStartTime);
          if (ts < sessionStartTime) {
            continue;
          }
          noteActivity(ts);

          const matched = findAndRemoveUnmatched(msg.toolCallId);
          if (!matched) {
            continue;
          }

          const { entryId, toolCall, assistantTimestamp, assistantModel } = matched;
          const recordId = `${entryId}:${toolCall.id}`;
          const toolName = toolCall.name;
          const toolNameLower = toolName.toLowerCase();
          const isFailure = msg.isError === true;
          const excludedFromErrors =
            this.metadata?.metricsConfig?.excludeErrorsFromTools?.map((n) => n.toLowerCase()).includes(toolNameLower) ??
            false;

          let fileOps: PiFileOperation[] = [];
          let apiErrorMessage: string | undefined;
          if (isFailure && !excludedFromErrors) {
            apiErrorMessage = this.extractToolResultErrorText(msg);
          } else if (isFailure && excludedFromErrors) {
            // Keep had_errors/error_tools reachable without uploading raw output.
            apiErrorMessage = `Tool failed: ${toolName}`;
          } else if (!isFailure) {
            fileOps = this.extractFileOperations(toolCall, msg).filter((op): op is PiFileOperation => op !== undefined);
          }

          const delta: PendingDelta = {
            ...base(recordId, assistantTimestamp),
            tools: { [toolName]: 1 },
            toolStatus: {
              [toolName]: {
                success: isFailure ? 0 : 1,
                failure: isFailure ? 1 : 0,
              },
            },
            ...(fileOps.length > 0 && { fileOperations: fileOps }),
            ...(assistantModel && { models: [assistantModel] }),
            ...(apiErrorMessage && { apiErrorMessage }),
          };

          maybePushDelta(delta);
          continue;
        }

        // A `!command` shell escape: the user ran it directly, so there is no tool
        // call/result pair and no model involved — hence no `models` on this delta.
        if (isPiBashExecutionMessage(msg)) {
          const ts = this.entryTimestamp(msg, sessionStartTime);
          if (ts < sessionStartTime) {
            continue;
          }
          // `!!` withholds the output from the model precisely because it is the user's
          // private shell session. Report nothing about it, not even that it ran.
          if (msg.excludeFromContext === true) {
            continue;
          }
          noteActivity(ts);

          // A cancelled command has no exit code, which counts as a failure.
          const succeeded = msg.exitCode === 0;
          maybePushDelta({
            ...base(`${entry.id}:bash`, ts),
            tools: { [BASH_TOOL]: 1 },
            toolStatus: { [BASH_TOOL]: { success: succeeded ? 1 : 0, failure: succeeded ? 0 : 1 } },
            // The command's own output is never uploaded — `bash` is in
            // excludeErrorsFromTools — so failures carry the same sanitized marker the
            // tool-result path produces.
            ...(!succeeded && { apiErrorMessage: `Tool failed: ${BASH_TOOL}` }),
          });
          continue;
        }
      }

      // Tool calls that never received a result are emitted without status, per spec §7.3 —
      // but only when this call is the run's last word on them. See PiMetricsProcessingContext.
      if (emitUnresolvedToolCalls) {
        for (const unmatched of unmatchedToolCalls) {
          const recordId = `${unmatched.entryId}:${unmatched.toolCall.id}`;
          const toolName = unmatched.toolCall.name;
          maybePushDelta({
            ...base(recordId, unmatched.assistantTimestamp),
            tools: { [toolName]: 1 },
            ...(unmatched.assistantModel && { models: [unmatched.assistantModel] }),
          });
        }
      }

      // Both of these run before the "nothing new" exit. The duration must, because on the
      // final flush every delta is already on disk and an early return would leave whatever
      // the last tick computed. The invocation totals must, because they accumulate across
      // this instance's transcripts and every batch has to settle its own share of them.
      await this.saveActiveDurationMs(session.sessionId, activityStart, activityEnd);
      const invocations = this.pendingInvocations(countedEntries, persisted.invocations);

      // A batch can owe counts while producing no delta to hang them on: a bare
      // `/skill:review` leaves no prompt text once the wrapper is stripped, and a plain
      // assistant reply emits nothing either. Deferring them to the next batch works
      // mid-run but loses them at the final flush, which has no next batch — so the batch
      // that owes them writes a record of its own.
      if (deltas.length === 0 && hasInvocations(invocations)) {
        deltas.push(
          base(
            nextInvocationRecordId(session.sessionId, existingRecordIds),
            // The window's own end, so a record that reports no activity cannot widen the
            // activity span it is later read back into.
            activityEnd ?? Date.now()
          )
        );
      }

      if (deltas.length === 0) {
        return {
          success: true,
          message: `No new deltas (${skippedDueToDedup} already processed)`,
          metadata: { recordsProcessed: entries.length, deltasWritten: 0, deltasSkipped: skippedDueToDedup },
        };
      }

      attachInvocations(deltas, invocations);

      const { MetricsWriter } = await import('../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
      const writer = new MetricsWriter(session.sessionId);
      for (const delta of deltas) {
        await writer.appendDelta(delta);
      }

      return {
        success: true,
        message: `Generated ${deltas.length} deltas`,
        metadata: { recordsProcessed: entries.length, deltasWritten: deltas.length, deltasSkipped: skippedDueToDedup },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[pi-metrics] Processing failed:`, error);
      return {
        success: false,
        message: `Metrics processing failed: ${msg}`,
        metadata: { failureReason: 'PROCESSING_ERROR' },
      };
    }
  }

  /**
   * The named invocations this batch still owes the aggregator.
   *
   * Folds the batch's entries into this instance's running totals, tops them up with the
   * ledger's view of the same run, and returns only what the JSONL does not already
   * account for. Called on every batch — including ones with no delta of their own, which
   * write a carrier record rather than hand the debt to a batch that may never come.
   */
  private pendingInvocations(countedEntries: PiEntry[], persisted: InvocationTotals): InvocationTotals {
    const named = extractPiNamedInvocations(countedEntries);
    addInvocationCounts(this.runInvocations.skillInvocations, named.skillInvocations);
    addInvocationCounts(this.runInvocations.agentInvocations, named.agentInvocations);
    addInvocationCounts(this.runInvocations.commandInvocations, named.commandInvocations);

    const skillTotal = { ...this.runInvocations.skillInvocations };
    const commandTotal = { ...this.runInvocations.commandInvocations };
    mergeInvocationCounts(skillTotal, this.ledgerInvocations?.skillCommandInvocations);
    mergeInvocationCounts(commandTotal, this.ledgerInvocations?.commandInvocations);

    return {
      skillInvocations: invocationIncrement(skillTotal, persisted.skillInvocations),
      agentInvocations: invocationIncrement(this.runInvocations.agentInvocations, persisted.agentInvocations),
      commandInvocations: invocationIncrement(commandTotal, persisted.commandInvocations),
    };
  }

  private async getCodeMieSessionStartTime(sessionId: string, session: ParsedSession): Promise<number> {
    try {
      const { SessionStore } = await import('../../../../core/session/SessionStore.js');
      const sessionStore = new SessionStore();
      const metadata = await sessionStore.loadSession(sessionId);
      if (metadata?.startTime) {
        return metadata.startTime;
      }
    } catch (error) {
      logger.warn('[pi-metrics] Could not load CodeMie session start time, using permissive fallback:', error);
    }

    const createdAt = session.metadata?.createdAt;
    if (createdAt) {
      const parsed = Date.parse(createdAt);
      if (!Number.isNaN(parsed)) return parsed;
    }

    logger.warn('[pi-metrics] No authoritative start time available, using permissive fallback');
    return 0;
  }

  private entryTimestamp(msg: { timestamp?: number }, fallback: number): number {
    return typeof msg.timestamp === 'number' && !Number.isNaN(msg.timestamp) ? msg.timestamp : fallback;
  }

  /** Envelope-level entries timestamp with an ISO string, unlike the messages they wrap. */
  private entryIsoTimestamp(timestamp: string | undefined, fallback: number): number {
    const parsed = timestamp ? Date.parse(timestamp) : NaN;
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  /**
   * The user's own words, with Pi's `/skill:<name>` wrapper removed. Pi prepends the
   * literal `<skill …>…</skill>` block to the text part that carries the real prompt;
   * `parseSkillWrapper` owns that shape, and the extractor keeps the name it strips.
   */
  private extractUserText(msg: { content: string | unknown[] }): string | undefined {
    if (typeof msg.content === 'string') {
      const text = parseSkillWrapper(msg.content).rest.trim();
      return text || undefined;
    }

    if (!Array.isArray(msg.content)) return undefined;

    const texts: string[] = [];
    for (const part of msg.content) {
      if (typeof part !== 'object' || part === null) continue;
      const typed = part as { type?: string; text?: string };
      if (typed.type !== 'text' || typeof typed.text !== 'string') continue;
      const text = parseSkillWrapper(typed.text).rest.trim();
      if (text) {
        texts.push(text);
      }
    }

    return texts.length > 0 ? texts.join('\n') : undefined;
  }

  private extractToolResultErrorText(result: PiToolResultMessage): string | undefined {
    const { content } = result;
    if (typeof content === 'string') {
      const text = content.trim();
      return text.length > 0 ? text : undefined;
    }

    if (!Array.isArray(content)) return undefined;

    const texts: string[] = [];
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      const typed = part as { type?: string; text?: string };
      if (typed.type !== 'text' || typeof typed.text !== 'string') continue;
      const text = typed.text.trim();
      if (text) texts.push(text);
    }

    const joined = texts.join('\n').trim();
    return joined.length > 0 ? joined : undefined;
  }

  /**
   * Persist the run's activity span.
   *
   * For Pi this is the only writer of the field: `SessionStore.accumulateActiveDuration`
   * keys off `UserPromptSubmit`, which Pi never fires, so it always contributes 0. The
   * bounds arrive already merged with the JSONL's, which makes the value monotonic — a
   * later tick can only widen the window it re-derives.
   *
   * Deliberately a different quantity than Claude's `activeDurationMs`: this is wall clock
   * from the first in-window entry to the last, idle time included, because Pi exposes no
   * event from which idle could be subtracted. Do not "align" the two by narrowing this
   * one — for a Pi session the alternative is not a tighter number, it is zero.
   */
  private async saveActiveDurationMs(
    sessionId: string,
    activityStart: number | undefined,
    activityEnd: number | undefined
  ): Promise<void> {
    if (activityStart === undefined || activityEnd === undefined) return;

    const activeDurationMs = activityEnd - activityStart;
    try {
      const { SessionStore } = await import('../../../../core/session/SessionStore.js');
      const sessionStore = new SessionStore();
      const metadata = await sessionStore.loadSession(sessionId);
      if (!metadata || metadata.activeDurationMs === activeDurationMs) return;

      metadata.activeDurationMs = activeDurationMs;
      await sessionStore.saveSession(metadata);
      logger.debug(`[pi-metrics] Saved activeDurationMs: ${activeDurationMs}`);
    } catch (error) {
      logger.debug('[pi-metrics] Failed to save active duration (non-blocking):', error);
    }
  }

  private extractFileOperations(toolCall: PiToolCall, result?: PiToolResultMessage): PiFileOperation[] {
    const op = extractPiFileOperation(toolCall.name, toolCall.arguments, result?.details);
    return op ? [op] : [];
  }

  /**
   * Read back what the session's JSONL already asserts.
   *
   * Returns `undefined` — meaning "do not process" — when the file exists but cannot be
   * read, because processing without it would duplicate every delta in it.
   */
  private async readPersistedMetrics(sessionId: string): Promise<PersistedMetrics | undefined> {
    const persisted: PersistedMetrics = {
      recordIds: new Set<string>(),
      invocations: emptyInvocationTotals(),
    };

    try {
      const { MetricsWriter } = await import('../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
      const writer = new MetricsWriter(sessionId);
      if (!writer.exists()) {
        return persisted;
      }

      const content = await readFile(writer.getFilePath(), 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let delta: RawPersistedDelta;
        try {
          delta = JSON.parse(trimmed) as RawPersistedDelta;
        } catch {
          // Skip malformed line rather than discarding the whole set.
          logger.debug('[pi-metrics] Skipping malformed delta line while loading existing record ids');
          continue;
        }

        if (typeof delta.recordId === 'string') {
          persisted.recordIds.add(delta.recordId);
        }
        if (typeof delta.timestamp === 'number' && Number.isFinite(delta.timestamp)) {
          persisted.activityStart =
            persisted.activityStart === undefined
              ? delta.timestamp
              : Math.min(persisted.activityStart, delta.timestamp);
          persisted.activityEnd =
            persisted.activityEnd === undefined
              ? delta.timestamp
              : Math.max(persisted.activityEnd, delta.timestamp);
        }

        addInvocationCounts(persisted.invocations.skillInvocations, readCountMap(delta.skillInvocations) ?? {});
        addInvocationCounts(persisted.invocations.agentInvocations, readCountMap(delta.agentInvocations) ?? {});
        addInvocationCounts(persisted.invocations.commandInvocations, readCountMap(delta.commandInvocations) ?? {});
      }
      return persisted;
    } catch (error) {
      logger.warn('[pi-metrics] Could not read existing deltas safely, skipping to avoid duplicates:', error);
      return undefined;
    }
  }
}

/**
 * Hang the batch's outstanding name maps off its first delta.
 *
 * They describe the batch rather than any single record, and the aggregator sums them
 * across deltas, so exactly one delta may carry them. Empty maps are omitted entirely
 * so the wire payload keeps its current shape for runs that used none of the three.
 */
function attachInvocations(deltas: PendingDelta[], invocations: InvocationTotals): void {
  if (deltas.length === 0) return;

  const { skillInvocations, agentInvocations, commandInvocations } = invocations;
  deltas[0] = {
    ...deltas[0],
    ...(Object.keys(skillInvocations).length > 0 && { skillInvocations }),
    ...(Object.keys(agentInvocations).length > 0 && { agentInvocations }),
    ...(Object.keys(commandInvocations).length > 0 && { commandInvocations }),
  };
}
