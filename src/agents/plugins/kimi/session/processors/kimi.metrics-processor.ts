/**
 * Kimi Metrics Processor
 *
 * Extracts metrics from Kimi Code session wire events.
 *
 * Responsibilities:
 * - Detect Kimi Code sessions
 * - Count tool calls and results from `context.append_loop_event` events
 * - Track file operations from display metadata
 * - Store aggregated metrics on the parsed session
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import { logger } from '../../../../../utils/logger.js';

interface KimiWireEvent {
  type: string;
  event?: {
    type?: string;
    uuid?: string;
    turnId?: string;
    step?: number;
    toolCallId?: string;
    parentUuid?: string;
    name?: string;
    args?: Record<string, unknown>;
    description?: string;
    result?: {
      output?: string;
      isError?: boolean;
    };
    usage?: {
      inputOther?: number;
      output?: number;
      inputCacheRead?: number;
      inputCacheCreation?: number;
    };
    finishReason?: string;
  };
  display?: {
    kind?: string;
    operation?: string;
    path?: string;
    content?: string;
    before?: string;
    after?: string;
  };
}

export class KimiMetricsProcessor implements SessionProcessor {
  readonly name = 'kimi-metrics';
  readonly priority = 1;

  shouldProcess(session: ParsedSession): boolean {
    return session.agentName === 'Kimi Code';
  }

  async process(session: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const messages = session.messages as KimiWireEvent[];
      const metrics = this.extractMetrics(messages);

      session.metrics = metrics;

      logger.debug(`[${this.name}] Extracted metrics for session ${session.sessionId}: ${messages.length} records`);

      return {
        success: true,
        metadata: { recordsProcessed: messages.length }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[${this.name}] Processing failed:`, error);

      return {
        success: false,
        message: `Metrics processing failed: ${errorMessage}`
      };
    }
  }

  private extractMetrics(events: KimiWireEvent[]): NonNullable<ParsedSession['metrics']> {
    const tools: Record<string, number> = {};
    const toolStatus: Record<string, { success: number; failure: number }> = {};
    const fileOperations: Array<{ type: string; path?: string }> = [];

    // First pass: index tool calls by toolCallId so tool results can be matched.
    const toolCallById = new Map<string, KimiWireEvent & { event: { name: string } }>();

    for (const event of events) {
      if (
        event.type === 'context.append_loop_event' &&
        event.event?.type === 'tool.call' &&
        typeof event.event.toolCallId === 'string' &&
        typeof event.event.name === 'string'
      ) {
        const toolName = event.event.name;
        tools[toolName] = (tools[toolName] || 0) + 1;

        if (!toolStatus[toolName]) {
          toolStatus[toolName] = { success: 0, failure: 0 };
        }

        const typedEvent = event as KimiWireEvent & { event: { name: string } };
        toolCallById.set(event.event.toolCallId, typedEvent);

        if (typeof event.event.uuid === 'string') {
          toolCallById.set(event.event.uuid, typedEvent);
        }
      }
    }

    // Second pass: match tool results to tool calls and update status.
    for (const event of events) {
      if (
        event.type !== 'context.append_loop_event' ||
        event.event?.type !== 'tool.result' ||
        !event.event.result
      ) {
        continue;
      }

      const matchedToolCall =
        (typeof event.event.toolCallId === 'string' && toolCallById.get(event.event.toolCallId)) ||
        (typeof event.event.parentUuid === 'string' && toolCallById.get(event.event.parentUuid));

      if (!matchedToolCall) {
        continue;
      }

      const toolName = matchedToolCall.event.name;
      const isError = event.event.result.isError === true;

      if (isError) {
        toolStatus[toolName].failure++;
      } else {
        toolStatus[toolName].success++;
      }
    }

    // Third pass: collect file operations from display metadata.
    for (const event of events) {
      if (event.type !== 'context.append_loop_event') {
        continue;
      }

      const display = event.display;
      if (!display || display.kind !== 'file_io') {
        continue;
      }

      const operation = display.operation;
      if (operation !== 'read' && operation !== 'write' && operation !== 'edit') {
        continue;
      }

      fileOperations.push({
        type: operation,
        path: typeof display.path === 'string' ? display.path : undefined,
      });
    }

    return { tools, toolStatus, fileOperations };
  }
}
