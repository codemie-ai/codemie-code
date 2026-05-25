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
import type { MetricDelta } from '../../../../core/metrics/types.js';
import type {
  CodexRolloutRecord,
  CodexResponseItem,
  CodexSessionMetadata,
} from '../../codex-message-types.js';
import { hasCodexMetadata } from '../../codex-message-types.js';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';

export class CodexMetricsProcessor implements SessionProcessor {
  readonly name = 'codex-metrics';
  readonly priority = 1;

  shouldProcess(session: ParsedSession): boolean {
    return session.messages.length > 0;
  }

  async process(session: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
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
      const functionCalls: Array<{ callId: string; item: CodexResponseItem }> = [];
      const outputs = new Map<string, CodexResponseItem>();

      for (const record of records) {
        if (record.type !== 'response_item') continue;
        const item = record.payload as CodexResponseItem;
        if (!item.call_id) continue;

        if (item.type === 'function_call') {
          functionCalls.push({ callId: item.call_id, item });
        } else if (item.type === 'function_call_output') {
          outputs.set(item.call_id, item);
        }
      }

      const baseTimestamp = resolveTimestamp(meta.createdAt);
      const resolvedBranch = await resolveBranch(meta);

      let deltasWritten = 0;

      for (const { callId, item } of functionCalls) {
        if (existingCallIds.has(callId)) continue;

        const toolName = (item.name ?? 'unknown').toLowerCase();
        const success = outputs.has(callId);
        const status = success ? { success: 1, failure: 0 } : { success: 0, failure: 1 };

        const delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'> = {
          recordId: callId,
          sessionId: session.sessionId,
          agentSessionId: meta.codexSessionId,
          timestamp: baseTimestamp,
          tools: { [toolName]: 1 },
          toolStatus: { [toolName]: status },
          ...(resolvedBranch ? { gitBranch: resolvedBranch } : {}),
          ...(meta.model ? { models: [meta.model] } : {}),
        };

        await writer.appendDelta(delta);
        existingCallIds.add(callId);
        deltasWritten++;
      }

      logger.debug(
        '[codex-metrics] Wrote deltas',
        ...sanitizeLogArgs({
          deltasWritten,
          totalCalls: functionCalls.length,
        })
      );

      return {
        success: true,
        message: `Generated ${deltasWritten} delta${deltasWritten === 1 ? '' : 's'}`,
        metadata: {
          recordsProcessed: functionCalls.length,
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
