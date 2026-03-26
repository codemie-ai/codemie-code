// src/agents/plugins/codex/session/processors/codex.metrics-processor.ts
/**
 * Codex Metrics Processor
 *
 * Extracts tool usage from Codex rollout JSONL records and writes a single
 * MetricDelta per session via MetricsWriter.
 *
 * Design decisions:
 * - One MetricDelta per session (D-6): Codex rollout files have no per-turn message IDs
 *   suitable for recordId, so session UUID from session_meta.id is used.
 * - Tool pairing via call_id (D-1): function_call + function_call_output share a call_id.
 *   Output record present → success; absent → failure.
 * - Token data omitted entirely (D-4): not present in rollout files.
 * - Deduplication by recordId (session UUID): prevents duplicate writes on onSessionEnd reruns.
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
import { readCodexJsonlTolerant } from '../../codex.storage-utils.js';
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
      // Validate required metadata
      if (!hasCodexMetadata(session.metadata)) {
        return {
          success: false,
          message: 'Missing codexSessionId in session.metadata',
          metadata: { failureReason: 'NO_CODEX_SESSION_ID' }
        };
      }

      const meta = session.metadata as CodexSessionMetadata;
      const codexSessionId = meta.codexSessionId;

      // Import MetricsWriter dynamically (mirrors OpenCode pattern)
      const { MetricsWriter } = await import('../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
      const writer = new MetricsWriter(session.sessionId);

      // Deduplication: skip if this rollout file (recordId = codexSessionId) already processed
      if (writer.exists()) {
        const existingDeltas = await readCodexJsonlTolerant<MetricDelta>(writer.getFilePath());
        const existingIds = new Set(existingDeltas.map(d => d.recordId));
        if (existingIds.has(codexSessionId)) {
          logger.debug(`[codex-metrics] Session ${codexSessionId} already processed, skipping`);
          return {
            success: true,
            message: 'Session already processed (deduplication)',
            metadata: { recordsProcessed: 0, deltasWritten: 0, skippedReason: 'ALREADY_PROCESSED' }
          };
        }
      }

      // Extract function_call and function_call_output records from pre-parsed messages
      const records = session.messages as CodexRolloutRecord[];
      const functionCalls = new Map<string, CodexResponseItem>();
      const functionCallOutputs = new Map<string, CodexResponseItem>();

      for (const record of records) {
        if (record.type !== 'response_item') continue;
        const item = record.payload as CodexResponseItem;
        if (!item.call_id) continue;

        if (item.type === 'function_call') {
          functionCalls.set(item.call_id, item);
        } else if (item.type === 'function_call_output') {
          functionCallOutputs.set(item.call_id, item);
        }
      }

      // Aggregate tool usage across all function_call records
      const tools: Record<string, number> = {};
      const toolStatus: Record<string, { success: number; failure: number }> = {};

      for (const [callId, fc] of functionCalls) {
        const toolName = (fc.name ?? 'unknown').toLowerCase();
        tools[toolName] = (tools[toolName] ?? 0) + 1;

        if (!toolStatus[toolName]) {
          toolStatus[toolName] = { success: 0, failure: 0 };
        }

        // Output record present → success; absent → failure (D-1)
        if (functionCallOutputs.has(callId)) {
          toolStatus[toolName].success++;
        } else {
          toolStatus[toolName].failure++;
        }
      }

      // Resolve timestamp: session_meta.timestamp → Date.now()
      let timestamp: number = Date.now();
      if (meta.createdAt) {
        const parsed = new Date(meta.createdAt).getTime();
        if (!isNaN(parsed)) {
          timestamp = parsed;
        }
      }

      // Build single MetricDelta for this session (D-6)
      const delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'> = {
        recordId: codexSessionId,
        sessionId: session.sessionId,
        agentSessionId: codexSessionId,
        timestamp,
        tools,
        ...(Object.keys(toolStatus).length > 0 && { toolStatus }),
        ...(meta.model ? { models: [meta.model] } : {}),
        // tokens intentionally omitted (D-4)
      };

      logger.debug(`[codex-metrics] Writing delta ${codexSessionId}:`, ...sanitizeLogArgs({
        tools: Object.keys(tools),
        toolCount: Object.keys(tools).length,
      }));

      await writer.appendDelta(delta);

      logger.info(`[codex-metrics] Wrote 1 delta for session ${session.sessionId}`);
      logger.info(`[codex-metrics] Metrics file: ${writer.getFilePath()}`);

      const _ = context; // context reserved for future API sync

      return {
        success: true,
        message: 'Generated 1 delta',
        metadata: {
          recordsProcessed: records.length,
          deltasWritten: 1,
        }
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[codex-metrics] Processing failed:', error);
      return {
        success: false,
        message: `Metrics processing failed: ${errorMessage}`,
        metadata: { failureReason: 'PROCESSING_ERROR' }
      };
    }
  }
}
