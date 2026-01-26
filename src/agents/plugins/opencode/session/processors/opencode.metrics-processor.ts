// src/agents/plugins/opencode/session/processors/opencode.metrics-processor.ts
import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import type {
  OpenCodeMessage,
  OpenCodeAssistantMessage
} from '../../opencode-message-types.js';
import { logger } from '../../../../../utils/logger.js';

/**
 * OpenCode Metrics Processor
 *
 * Aggregates token usage and tool statistics from OpenCode sessions.
 * Implements SessionProcessor interface for processor chain.
 *
 * UPDATED (GPT-5.9): Uses discriminated union types for safe access
 * to assistant-specific fields.
 */
export class OpenCodeMetricsProcessor implements SessionProcessor {
  readonly name = 'opencode-metrics';
  readonly priority = 1;  // Run first (before conversations)

  /**
   * Check if session has data to process
   */
  shouldProcess(session: ParsedSession): boolean {
    return session.messages.length > 0;
  }

  /**
   * Process session to aggregate metrics
   *
   * Token Aggregation Rules (GPT-5.8 fix):
   * 1. Primary: Use message.tokens if present on assistant messages
   * 2. Fallback: Only use step-finish part tokens if message has NO tokens
   * 3. Never sum both to avoid double-counting
   */
  async process(session: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const messages = session.messages as OpenCodeMessage[];

      // Aggregate tokens from assistant messages
      let totalInput = 0;
      let totalOutput = 0;
      let totalReasoning = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let totalCost = 0;
      let messagesWithTokens = 0;
      let messagesWithoutTokens = 0;

      for (const msg of messages) {
        // UPDATED (GPT-5.9): Type-safe access to assistant message fields
        if (msg.role === 'assistant') {
          const assistantMsg = msg as OpenCodeAssistantMessage;

          // UPDATED (GPT-5.8): Deterministic token rules
          if (assistantMsg.tokens) {
            // Primary source: message-level tokens
            totalInput += assistantMsg.tokens.input || 0;
            totalOutput += assistantMsg.tokens.output || 0;
            totalReasoning += assistantMsg.tokens.reasoning || 0;
            cacheRead += assistantMsg.tokens.cache?.read || 0;
            cacheWrite += assistantMsg.tokens.cache?.write || 0;
            messagesWithTokens++;
          } else {
            // Message has no tokens - would need step-finish fallback
            // This requires loading parts, which is outside processor scope
            // Log for debugging
            messagesWithoutTokens++;
          }

          // Cost is always on message (not in parts)
          // FIXED (GPT-5.11): Use typeof check to handle valid 0 values
          if (typeof assistantMsg.cost === 'number') {
            totalCost += assistantMsg.cost;
          }
        }
      }

      logger.debug(
        `[opencode-metrics] Processed ${messages.length} messages: ` +
        `${totalInput} input, ${totalOutput} output, ${totalReasoning} reasoning tokens ` +
        `(${messagesWithTokens} with tokens, ${messagesWithoutTokens} without)`
      );

      // Ensure session.metrics exists before mutating (GPT-5.8 fix)
      if (!session.metrics) {
        (session as { metrics: ParsedSession['metrics'] }).metrics = {
          tokens: { input: 0, output: 0 },
          tools: {},
          toolStatus: {},
          fileOperations: []
        };
      }

      // Update session metrics (mutate in place for downstream processors)
      session.metrics!.tokens = {
        input: totalInput,
        output: totalOutput,
        cacheRead,
        cacheWrite
      };

      return {
        success: true,
        message: `Aggregated ${totalInput + totalOutput} tokens from ${messages.length} messages`,
        metadata: {
          recordsProcessed: messages.length,
          totalInputTokens: totalInput,
          totalOutputTokens: totalOutput,
          totalReasoningTokens: totalReasoning,
          totalCost,
          messagesWithTokens,
          messagesWithoutTokens  // Useful for debugging token coverage
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[opencode-metrics] Processing failed:`, error);
      return {
        success: false,
        message: `Metrics processing failed: ${errorMessage}`
      };
    }
  }
}
