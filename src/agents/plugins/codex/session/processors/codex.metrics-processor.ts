// src/agents/plugins/codex/session/processors/codex.metrics-processor.ts
/**
 * Codex Metrics Processor
 *
 * Extracts tool usage from Codex rollout JSONL records and writes one
 * MetricDelta per function_call (keyed on call_id). Tokens are intentionally
 * omitted — Codex rollout files do not carry per-call usage. gitBranch is
 * propagated so aggregateDeltas produces real per-branch metrics instead of
 * collapsing everything to "unknown".
 *
 * Safe to call repeatedly — dedupes against the existing JSONL by call_id.
 * This is what makes the in-process incremental sync timer cheap to run.
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import { resolveRunWindow } from '../../../../core/session/run-window.js';
import type { MetricDelta } from '../../../../core/metrics/types.js';
import type {
  CodexRolloutRecord,
  CodexResponseItem,
  CodexSessionMetadata,
} from '../../codex-message-types.js';
import { hasCodexMetadata } from '../../codex-message-types.js';
import { collectApplyPatchCalls, isApplyPatchItem } from '../codex-apply-patch.js';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';

export class CodexMetricsProcessor implements SessionProcessor {
  readonly name = 'codex-metrics';
  readonly priority = 1;

  shouldProcess(session: ParsedSession): boolean {
    return session.messages.length > 0;
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    try {
      if (!hasCodexMetadata(session.metadata)) {
        return {
          success: false,
          message: 'Missing codexSessionId in session.metadata',
          metadata: { failureReason: 'NO_CODEX_SESSION_ID' },
        };
      }

      const meta = session.metadata as CodexSessionMetadata;

      const { MetricsWriter } = await import(
        '../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js'
      );
      const writer = new MetricsWriter(session.sessionId);

      const existing = writer.exists() ? await writer.readAll() : [];
      const existingCallIds = new Set(existing.map((d) => d.recordId));

      const records = session.messages as CodexRolloutRecord[];
      const functionCalls: Array<{ callId: string; item: CodexResponseItem; timestamp?: string }> = [];
      const outputs = new Map<string, CodexResponseItem>();

      for (const record of records) {
        if (record.type !== 'response_item') continue;
        const item = record.payload as CodexResponseItem;
        if (!item.call_id) continue;

        if (item.type === 'function_call') {
          // apply_patch takes its own path below (outcome-aware, with file operations)
          if (isApplyPatchItem(item)) continue;
          functionCalls.push({ callId: item.call_id, item, timestamp: record.timestamp });
        } else if (item.type === 'function_call_output') {
          outputs.set(item.call_id, item);
        }
      }

      const baseTimestamp = resolveTimestamp(meta.createdAt);
      const resolvedBranch = await resolveBranch(meta);

      const deltas: Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> = [];

      for (const { callId, item, timestamp } of functionCalls) {
        if (existingCallIds.has(callId)) continue;
        // No output yet: the call gets its delta, with its real status, once the output appears.
        if (!outputs.has(callId)) continue;

        const toolName = (item.name ?? 'unknown').toLowerCase();

        const delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'> = {
          recordId: callId,
          sessionId: session.sessionId,
          agentSessionId: meta.codexSessionId,
          timestamp: typeof timestamp === 'string' && !isNaN(Date.parse(timestamp)) ? Date.parse(timestamp) : baseTimestamp,
          tools: { [toolName]: 1 },
          toolStatus: { [toolName]: { success: 1, failure: 0 } },
          ...(resolvedBranch ? { gitBranch: resolvedBranch } : {}),
          ...(meta.model ? { models: [meta.model] } : {}),
        };

        deltas.push(delta);
        existingCallIds.add(callId);
      }

      // apply_patch: one delta per call with a known outcome, carrying its file operations. The call_id
      // dedupe runs before the patch is parsed.
      const patchCalls = collectApplyPatchCalls(await familyRecords(meta, records, session), existingCallIds);
      const window = deltas.length > 0 || patchCalls.length > 0 ? await resolveRunWindow(session.sessionId, context) : undefined;
      for (const call of patchCalls) {
        const callTime = call.timestamp ? Date.parse(call.timestamp) : NaN;
        // The generic window below keeps its lower bound off; apply_patch calls are filtered on their own time
        if (window && !isNaN(callTime) && callTime < window.startTime) continue;
        deltas.push({
          recordId: call.callId,
          sessionId: session.sessionId,
          agentSessionId: meta.codexSessionId,
          timestamp: isNaN(callTime) ? baseTimestamp : callTime,
          tools: { apply_patch: 1 },
          toolStatus: { apply_patch: { success: call.ok ? 1 : 0, failure: call.ok ? 0 : 1 } },
          ...(call.ok && call.fileOperations.length > 0
            ? { fileOperations: call.fileOperations as NonNullable<MetricDelta['fileOperations']> }
            : {}),
          ...(resolvedBranch ? { gitBranch: resolvedBranch } : {}),
          ...(meta.model ? { models: [meta.model] } : {}),
        });
        existingCallIds.add(call.callId);
      }

      let deltasWritten = 0;
      if (deltas.length > 0 && window) {
        // ponytail: a call without a timestamped line gets the session's createdAt, earlier than a resumed record's
        // start, so the window's lower bound stays off for generic calls; apply_patch calls are filtered on their
        // own line time above. Enable the bound once every call carries its own line time.
        const appended = await writer.appendDeltas(deltas, { ...window, startTime: -Infinity });
        if (appended.gone) {
          logger.warn(`[codex-metrics] Metrics file of session ${session.sessionId} is gone (completed); ${deltas.length} deltas not written`);
          return { success: false, message: `Metrics file of session ${session.sessionId} is gone; deltas not written` };
        }
        deltasWritten = appended.written;
      }

      logger.debug(
        '[codex-metrics] Wrote deltas',
        ...sanitizeLogArgs({
          deltasWritten,
          totalCalls: functionCalls.length + patchCalls.length,
        })
      );

      return {
        success: true,
        message: `Generated ${deltasWritten} delta${deltasWritten === 1 ? '' : 's'}`,
        metadata: {
          recordsProcessed: functionCalls.length + patchCalls.length,
          deltasWritten,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[codex-metrics] Processing failed:', error);
      return {
        success: false,
        message: `Metrics processing failed: ${errorMessage}`,
        metadata: { failureReason: 'PROCESSING_ERROR' },
      };
    }
  }
}

function resolveTimestamp(value: unknown): number {
  if (typeof value === 'string') {
    const ts = new Date(value).getTime();
    if (!isNaN(ts)) return ts;
  }
  if (typeof value === 'number') return value;
  return Date.now();
}

async function resolveBranch(meta: CodexSessionMetadata): Promise<string | undefined> {
  if (meta.branch) return meta.branch;
  if (!meta.projectPath) return undefined;
  try {
    const { detectGitBranch } = await import('../../../../../utils/processes.js');
    const branch = await detectGitBranch(meta.projectPath);
    return branch ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records apply_patch calls are read from: the parent rollout plus its direct children, so a fresh
 * child picked over an older (resumed) parent still reports the parent's edits. Without a rollout
 * path the picked records and the loaded sub-agents are used.
 */
async function familyRecords(
  meta: CodexSessionMetadata,
  records: CodexRolloutRecord[],
  session: ParsedSession
): Promise<CodexRolloutRecord[]> {
  const subagents = (session.subagents ?? []) as Array<{ filePath: string; messages: unknown[] }>;
  if (!meta.rolloutPath) {
    return [...records, ...subagents.flatMap((s) => s.messages as CodexRolloutRecord[])];
  }
  try {
    const { loadRolloutFamilyRecords } = await import('../../codex.session.js');
    return await loadRolloutFamilyRecords(
      meta.rolloutPath,
      records,
      subagents as Array<{ agentId: string; filePath: string; messages: unknown[] }>
    );
  } catch (error) {
    logger.debug('[codex-metrics] Could not load the rollout family; using the picked rollout', error);
    return [...records, ...subagents.flatMap((s) => s.messages as CodexRolloutRecord[])];
  }
}
