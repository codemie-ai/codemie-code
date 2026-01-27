/**
 * Token aggregation for Gemini conversations
 *
 * Aggregates token usage across multiple Gemini messages in a single turn.
 *
 * Gemini Token Mapping:
 * - input_tokens: msg[0].tokens.input (first gemini message)
 * - output_tokens: SUM(all msg.tokens.output)
 * - cache_read_input_tokens: msg[last].tokens.cached
 * - cache_creation_input_tokens: 0 (not tracked by Gemini)
 */

import type { GeminiMessage } from './turn-detector.js';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * Aggregates token usage from multiple Gemini messages in a turn
 *
 * @param geminiMessages - All Gemini messages in the turn
 * @returns Aggregated token usage
 */
export function aggregateTokens(geminiMessages: GeminiMessage[]): TokenUsage {
  if (geminiMessages.length === 0) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    };
  }

  const first = geminiMessages[0];
  const last = geminiMessages[geminiMessages.length - 1];

  // Sum output tokens across all messages
  const totalOutput = geminiMessages.reduce(
    (sum, msg) => sum + (msg.tokens?.output || 0),
    0
  );

  return {
    input_tokens: first.tokens?.input || 0,
    output_tokens: totalOutput,
    cache_read_input_tokens: last.tokens?.cached || 0,
    cache_creation_input_tokens: 0 // Not tracked by Gemini
  };
}
