/**
 * Metrics processor for Copilot CLI sessions.
 *
 * Extraction itself happens in `parseSessionFile` (one pass over `events.jsonl`); this
 * processor exists so the adapter follows the same `SessionProcessor` orchestration every
 * other agent uses.
 */

import type {
  SessionProcessor,
  ProcessingContext,
  ProcessingResult,
} from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';

export class CopilotCliMetricsProcessor implements SessionProcessor {
  readonly name = 'copilot-cli-metrics';
  readonly priority = 10;

  shouldProcess(session: ParsedSession): boolean {
    return session.metrics !== undefined;
  }

  async process(session: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
    const toolCalls = Object.values(session.metrics?.tools ?? {}).reduce((sum, n) => sum + n, 0);
    return {
      success: true,
      metadata: { recordsProcessed: toolCalls },
    };
  }
}
