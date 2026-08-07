/**
 * Pi Metrics Processor
 *
 * Translates Pi session JSONL entries into MetricDelta records and writes
 * them to JSONL for eventual sync to the CodeMie API.
 */

import { readFile } from 'fs/promises';
import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import type { MetricDelta } from '../../../../core/metrics/types.js';
import type { AgentMetadata } from '../../../../core/types.js';
import { logger } from '../../../../../utils/logger.js';
import {
  isPiMessageEntry,
  isPiUserMessage,
  isPiAssistantMessage,
  isPiToolResultMessage,
  type PiEntry,
  type PiAssistantMessage,
  type PiToolCall,
  type PiToolResultMessage,
} from '../../pi.types.js';
import { extractPiFileOperation } from '../pi-file-operations.js';

const PI_METRICS_PROCESSOR_NAME = 'pi-metrics';

type PendingDelta = Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>;
type PiFileOperation = NonNullable<ReturnType<typeof extractPiFileOperation>>;

interface UnmatchedToolCall {
  entryId: string;
  toolCall: PiToolCall;
  assistantTimestamp: number;
  assistantModel?: string;
}

export class PiMetricsProcessor implements SessionProcessor {
  readonly name = PI_METRICS_PROCESSOR_NAME;
  readonly priority = 1;

  // Tracks Pi entry ids already seen across all files in this run. /new and /fork
  // copy history into a new transcript; this set prevents double-counting.
  private readonly seenEntryIds = new Set<string>();

  // Running activity window across every transcript processed in this run. The
  // hook calls process() once per discovered transcript, so the bounds must be
  // merged rather than recomputed per file.
  private activeWindowStart: number | undefined;
  private activeWindowEnd: number | undefined;

  constructor(private readonly metadata: AgentMetadata | undefined = undefined) {}

  shouldProcess(session: ParsedSession): boolean {
    return session.messages.length > 0;
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const entries = session.messages as PiEntry[];
      const existingRecordIds = await this.getExistingRecordIds(session.sessionId);
      if (existingRecordIds === undefined) {
        return {
          success: true,
          message: 'Skipping metrics processing: could not read existing deltas safely',
          metadata: { recordsProcessed: entries.length, deltasWritten: 0 },
        };
      }

      // Bound entry processing to this CodeMie run. On `--continue` / `-r` Pi appends
      // to the same transcript, so entries from earlier runs must not be re-emitted.
      const sessionStartTime = await this.getCodeMieSessionStartTime(session.sessionId, session);
      const gitBranch = context.gitBranch;
      const fallbackModel = process.env.CODEMIE_MODEL;

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

        if (!isPiMessageEntry(entry)) {
          continue;
        }

        const msg = entry.message;

        if (isPiUserMessage(msg)) {
          const ts = this.entryTimestamp(msg, sessionStartTime);
          if (ts < sessionStartTime) {
            continue;
          }
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
          const assistantModel = msg.model || fallbackModel;
          const toolCalls = this.extractToolCalls(msg);

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
      }

      // Tool calls that never received a result are emitted without status, per spec §7.3.
      for (const unmatched of unmatchedToolCalls) {
        const recordId = `${unmatched.entryId}:${unmatched.toolCall.id}`;
        const toolName = unmatched.toolCall.name;
        maybePushDelta({
          ...base(recordId, unmatched.assistantTimestamp),
          tools: { [toolName]: 1 },
          ...(unmatched.assistantModel && { models: [unmatched.assistantModel] }),
        });
      }

      if (deltas.length === 0) {
        return {
          success: true,
          message: `No new deltas (${skippedDueToDedup} already processed)`,
          metadata: { recordsProcessed: entries.length, deltasWritten: 0, deltasSkipped: skippedDueToDedup },
        };
      }

      const { MetricsWriter } = await import('../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
      const writer = new MetricsWriter(session.sessionId);
      for (const delta of deltas) {
        await writer.appendDelta(delta);
      }

      // Derive active duration from the first to last emitted delta. This avoids
      // reporting the full wall-clock span as activity time.
      await this.saveActiveDurationMs(session.sessionId, deltas);

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

  private extractUserText(msg: { content: string | unknown[] }): string | undefined {
    if (typeof msg.content === 'string') {
      const withoutWrapper = this.stripSkillWrapper(msg.content);
      const text = (withoutWrapper ?? msg.content).trim();
      return text || undefined;
    }

    if (!Array.isArray(msg.content)) return undefined;

    const texts: string[] = [];
    for (const part of msg.content) {
      if (typeof part !== 'object' || part === null) continue;
      const typed = part as { type?: string; text?: string };
      if (typed.type !== 'text' || typeof typed.text !== 'string') continue;
      const withoutWrapper = this.stripSkillWrapper(typed.text);
      const text = (withoutWrapper ?? typed.text).trim();
      if (text) {
        texts.push(text);
      }
    }

    return texts.length > 0 ? texts.join('\n') : undefined;
  }

  /**
   * Strip Pi's `/skill:<name>` wrapper from the start of a text block.
   * Pi emits the literal `<skill name="..." location="...">\n...\n</skill>\n\n`
   * block followed by the real user prompt in a single text part. Returns the
   * trailing user text if a wrapper was removed, otherwise undefined.
   */
  private stripSkillWrapper(text: string): string | undefined {
    const skillBlockPattern = /^<skill\s+name="[^"]*"\s+location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n)?/;
    const match = skillBlockPattern.exec(text);
    if (!match) return undefined;
    return text.slice(match[0].length);
  }

  private extractToolCalls(msg: PiAssistantMessage): PiToolCall[] {
    if (!Array.isArray(msg.content)) {
      return [];
    }

    return msg.content
      .map((part): PiToolCall | undefined => {
        if (typeof part !== 'object' || part === null) {
          return undefined;
        }

        // Pi runtime emits the flat ToolCall shape directly in the content array.
        const flat = part as PiToolCall;
        if (flat.type === 'toolCall' && typeof flat.id === 'string' && typeof flat.name === 'string') {
          return flat;
        }

        // Defensive: also accept a nested wrapper shape `{ type: 'toolCall', toolCall: {...} }`
        // in case a Pi version or provider serializes it differently. The inner object may
        // or may not repeat the `type` field.
        const nested = (part as { type?: string; toolCall?: PiToolCall }).toolCall;
        if (nested && typeof nested.id === 'string' && typeof nested.name === 'string') {
          return nested;
        }

        return undefined;
      })
      .filter((toolCall): toolCall is PiToolCall => toolCall !== undefined);
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
   * Merge this transcript's delta timestamps into the run-wide activity window and
   * persist the resulting duration.
   *
   * The window bounds are merged, not the per-file spans: two transcripts covering
   * disjoint periods form one window spanning both, which `Math.max` of their
   * individual spans would understate.
   */
  private async saveActiveDurationMs(sessionId: string, deltas: PendingDelta[]): Promise<void> {
    if (deltas.length === 0) return;

    let minTimestamp = Infinity;
    let maxTimestamp = -Infinity;
    for (const delta of deltas) {
      if (typeof delta.timestamp === 'number') {
        minTimestamp = Math.min(minTimestamp, delta.timestamp);
        maxTimestamp = Math.max(maxTimestamp, delta.timestamp);
      }
    }
    if (!Number.isFinite(minTimestamp) || !Number.isFinite(maxTimestamp)) return;

    this.activeWindowStart = Math.min(this.activeWindowStart ?? minTimestamp, minTimestamp);
    this.activeWindowEnd = Math.max(this.activeWindowEnd ?? maxTimestamp, maxTimestamp);

    try {
      const { SessionStore } = await import('../../../../core/session/SessionStore.js');
      const sessionStore = new SessionStore();
      const metadata = await sessionStore.loadSession(sessionId);
      if (metadata) {
        metadata.activeDurationMs = this.activeWindowEnd - this.activeWindowStart;
        await sessionStore.saveSession(metadata);
        logger.debug(`[pi-metrics] Saved activeDurationMs: ${metadata.activeDurationMs}`);
      }
    } catch (error) {
      logger.debug('[pi-metrics] Failed to save active duration (non-blocking):', error);
    }
  }

  private extractFileOperations(toolCall: PiToolCall, result?: PiToolResultMessage): PiFileOperation[] {
    const op = extractPiFileOperation(toolCall.name, toolCall.arguments, result?.details);
    return op ? [op] : [];
  }

  private async getExistingRecordIds(sessionId: string): Promise<Set<string> | undefined> {
    try {
      const { MetricsWriter } = await import('../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
      const writer = new MetricsWriter(sessionId);
      if (!writer.exists()) {
        return new Set();
      }

      const content = await readFile(writer.getFilePath(), 'utf-8');
      const recordIds = new Set<string>();
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const delta = JSON.parse(trimmed) as { recordId?: unknown };
          if (typeof delta.recordId === 'string') {
            recordIds.add(delta.recordId);
          }
        } catch {
          // Skip malformed line rather than discarding the whole set.
          logger.debug('[pi-metrics] Skipping malformed delta line while loading existing record ids');
        }
      }
      return recordIds;
    } catch (error) {
      logger.warn('[pi-metrics] Could not read existing deltas safely, skipping to avoid duplicates:', error);
      return undefined;
    }
  }
}
