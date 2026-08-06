/**
 * Conversations processor for Copilot CLI sessions.
 *
 * Copilot persists prompt text in `events.jsonl`; `parseSessionFile` captures it into
 * `metrics.userPrompts`.
 */

import type {
  SessionProcessor,
  ProcessingContext,
  ProcessingResult,
} from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';

export class CopilotCliConversationsProcessor implements SessionProcessor {
  readonly name = 'copilot-cli-conversations';
  readonly priority = 20;

  shouldProcess(session: ParsedSession): boolean {
    return (session.metrics?.userPrompts?.length ?? 0) > 0;
  }

  async process(session: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
    return {
      success: true,
      metadata: { recordsProcessed: session.metrics?.userPrompts?.length ?? 0 },
    };
  }
}
