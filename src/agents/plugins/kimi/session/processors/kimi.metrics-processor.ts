/**
 * Kimi Metrics Processor
 *
 * Placeholder processor for Kimi Code session metrics.
 *
 * Responsibilities:
 * - Detect Kimi Code sessions
 * - Report how many records were seen for metrics aggregation
 *
 * Full delta generation and JSONL writing will be implemented in a follow-up task.
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import { logger } from '../../../../../utils/logger.js';

export class KimiMetricsProcessor implements SessionProcessor {
  readonly name = 'kimi-metrics';
  readonly priority = 1;

  shouldProcess(session: ParsedSession): boolean {
    return session.agentName === 'Kimi Code';
  }

  async process(session: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const recordsProcessed = session.messages.length;

      logger.debug(`[${this.name}] Metrics aggregation placeholder for session ${session.sessionId}: ${recordsProcessed} records`);

      return {
        success: true,
        message: 'Metrics processing placeholder completed',
        metadata: { recordsProcessed }
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
}
