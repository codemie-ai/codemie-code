/**
 * Pi Metrics Processor
 *
 * Translates Pi session JSONL entries into MetricDelta records and writes
 * them to JSONL for eventual sync to the CodeMie API.
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import type { MetricDelta } from '../../../../core/metrics/types.js';
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

export class PiMetricsProcessor implements SessionProcessor {
  readonly name = PI_METRICS_PROCESSOR_NAME;
  readonly priority = 1;

  shouldProcess(session: ParsedSession): boolean {
    return session.messages.length > 0;
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const entries = session.messages as PiEntry[];
      const existingRecordIds = await this.getExistingRecordIds(session.sessionId);
      const gitBranch = context.gitBranch;

      const toolResultByToolCallId = new Map<string, PiToolResultMessage>();
      for (const entry of entries) {
        if (isPiMessageEntry(entry) && isPiToolResultMessage(entry.message)) {
          toolResultByToolCallId.set(entry.message.toolCallId, entry.message);
        }
      }

      const deltas: PendingDelta[] = [];
      let skippedDueToDedup = 0;

      const base = (recordId: string, timestamp: number): PendingDelta => ({
        recordId,
        sessionId: session.sessionId,
        agentSessionId: context.sessionId ?? session.sessionId,
        timestamp,
        ...(gitBranch && { gitBranch }),
      });

      for (const entry of entries) {
        if (!isPiMessageEntry(entry)) {
          continue;
        }

        const msg = entry.message;

        if (isPiUserMessage(msg)) {
          const text = this.extractUserText(msg);
          if (!text) {
            continue;
          }
          const recordId = `${entry.id}:prompt`;
          if (existingRecordIds.has(recordId)) {
            skippedDueToDedup++;
            continue;
          }
          deltas.push({ ...base(recordId, msg.timestamp), userPrompts: [{ count: 1, text }] });
          continue;
        }

        if (isPiAssistantMessage(msg)) {
          const toolCalls = this.extractToolCalls(msg);

          for (const toolCall of toolCalls) {
            const recordId = `${entry.id}:${toolCall.id}`;
            if (existingRecordIds.has(recordId)) {
              skippedDueToDedup++;
              continue;
            }

            const result = toolResultByToolCallId.get(toolCall.id);
            const toolName = toolCall.name.toLowerCase();
            const isFailure = result?.isError === true;
            const fileOps = !isFailure
              ? this.extractFileOperations(toolCall, result).filter((op): op is PiFileOperation => op !== undefined)
              : [];

            const delta: PendingDelta = {
              ...base(recordId, msg.timestamp),
              tools: { [toolName]: 1 },
              toolStatus: {
                [toolName]: {
                  success: isFailure ? 0 : 1,
                  failure: isFailure ? 1 : 0,
                },
              },
              ...(fileOps.length > 0 && { fileOperations: fileOps }),
              ...(msg.model && { models: [msg.model] }),
            };

            deltas.push(delta);
          }

          if (msg.errorMessage) {
            const recordId = `${entry.id}:error`;
            if (!existingRecordIds.has(recordId)) {
              deltas.push({
                ...base(recordId, msg.timestamp),
                apiErrorMessage: msg.errorMessage,
                ...(msg.model && { models: [msg.model] }),
              });
            } else {
              skippedDueToDedup++;
            }
          }
        }
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

  private extractUserText(msg: { content: string | unknown[] }): string | undefined {
    if (typeof msg.content === 'string') {
      return msg.content.trim() || undefined;
    }
    const textParts = (msg.content as unknown[])
      .filter((part): part is { type: string; text?: string } => typeof part === 'object' && part !== null)
      .map(part => part.text)
      .filter((text): text is string => typeof text === 'string' && text.trim().length > 0);
    return textParts.length > 0 ? textParts.join('\n') : undefined;
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

  private extractFileOperations(toolCall: PiToolCall, result?: PiToolResultMessage): PiFileOperation[] {
    const op = extractPiFileOperation(toolCall.name, toolCall.arguments, result?.details);
    return op ? [op] : [];
  }

  private async getExistingRecordIds(sessionId: string): Promise<Set<string>> {
    try {
      const { MetricsWriter } = await import('../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
      const writer = new MetricsWriter(sessionId);
      if (!writer.exists()) {
        return new Set();
      }
      const existing = await writer.readAll();
      return new Set(existing.map(d => d.recordId));
    } catch (error) {
      logger.warn('[pi-metrics] Could not read existing deltas:', error);
      return new Set();
    }
  }
}
