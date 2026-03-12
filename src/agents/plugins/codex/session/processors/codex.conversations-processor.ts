// src/agents/plugins/codex/session/processors/codex.conversations-processor.ts
/**
 * Codex Conversations Processor
 *
 * Normalises user messages and assistant responses from Codex rollout records
 * into a unified conversation format.
 *
 * This processor is a placeholder for Phase 2 conversation sync.
 * It runs and normalises data but does not write to the API in the initial delivery.
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import type { CodexRolloutRecord, CodexResponseItem, CodexEventMsg } from '../../codex-message-types.js';
import { logger } from '../../../../../utils/logger.js';

interface NormalizedMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export class CodexConversationsProcessor implements SessionProcessor {
  readonly name = 'codex-conversations';
  readonly priority = 2;

  shouldProcess(session: ParsedSession): boolean {
    return session.messages.length > 0;
  }

  async process(session: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const records = session.messages as CodexRolloutRecord[];
      const normalizedMessages: NormalizedMessage[] = [];

      for (const record of records) {
        if (record.type === 'event_msg') {
          const event = record.payload as CodexEventMsg;
          if (event.type === 'user_message' && event.message) {
            normalizedMessages.push({
              role: 'user',
              content: event.message,
            });
          }
        } else if (record.type === 'response_item') {
          const item = record.payload as CodexResponseItem;
          if (item.type === 'message' && item.output) {
            normalizedMessages.push({
              role: 'assistant',
              content: item.output,
            });
          }
        }
      }

      logger.debug(
        `[codex-conversations] Normalised ${normalizedMessages.length} messages`
      );

      return {
        success: true,
        message: `Normalised ${normalizedMessages.length} messages`,
        metadata: {
          recordsProcessed: normalizedMessages.length,
          userMessages: normalizedMessages.filter(m => m.role === 'user').length,
          assistantMessages: normalizedMessages.filter(m => m.role === 'assistant').length,
        }
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[codex-conversations] Processing failed:', error);
      return {
        success: false,
        message: `Conversations processing failed: ${errorMessage}`,
      };
    }
  }
}
