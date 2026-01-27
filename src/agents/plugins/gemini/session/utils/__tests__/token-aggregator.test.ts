import { describe, it, expect } from 'vitest';
import { aggregateTokens } from '../token-aggregator.js';
import type { GeminiMessage } from '../turn-detector.js';

describe('token-aggregator', () => {
  describe('aggregateTokens', () => {
    it('should aggregate tokens from single gemini message', () => {
      const messages: GeminiMessage[] = [
        {
          id: 'msg-1',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:00Z',
          content: 'Response',
          tokens: {
            input: 100,
            output: 50,
            cached: 20,
            thoughts: 10,
            tool: 5
          }
        }
      ];

      const result = aggregateTokens(messages);

      expect(result).toEqual({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 0
      });
    });

    it('should sum output tokens across multiple messages', () => {
      const messages: GeminiMessage[] = [
        {
          id: 'msg-1',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:00Z',
          content: 'Part 1',
          tokens: {
            input: 100,
            output: 30,
            cached: 10,
            thoughts: 5,
            tool: 2
          }
        },
        {
          id: 'msg-2',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:01Z',
          content: 'Part 2',
          tokens: {
            input: 0,
            output: 40,
            cached: 15,
            thoughts: 0,
            tool: 0
          }
        },
        {
          id: 'msg-3',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:02Z',
          content: 'Part 3',
          tokens: {
            input: 0,
            output: 25,
            cached: 20,
            thoughts: 0,
            tool: 0
          }
        }
      ];

      const result = aggregateTokens(messages);

      expect(result).toEqual({
        input_tokens: 100, // From first message
        output_tokens: 95, // 30 + 40 + 25
        cache_read_input_tokens: 20, // From last message
        cache_creation_input_tokens: 0 // Always 0 for Gemini
      });
    });

    it('should handle empty messages array', () => {
      const result = aggregateTokens([]);

      expect(result).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      });
    });

    it('should handle missing token data gracefully', () => {
      const messages: GeminiMessage[] = [
        {
          id: 'msg-1',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:00Z',
          content: 'Response'
          // No tokens field
        }
      ];

      const result = aggregateTokens(messages);

      expect(result).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      });
    });

    it('should handle partial token data', () => {
      const messages: GeminiMessage[] = [
        {
          id: 'msg-1',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:00Z',
          content: 'Part 1',
          tokens: {
            input: 100,
            output: 30,
            cached: 0,
            thoughts: 0,
            tool: 0
          }
        },
        {
          id: 'msg-2',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:01Z',
          content: 'Part 2'
          // No tokens field
        }
      ];

      const result = aggregateTokens(messages);

      expect(result).toEqual({
        input_tokens: 100,
        output_tokens: 30, // Only from first message
        cache_read_input_tokens: 0, // Last message has no tokens
        cache_creation_input_tokens: 0
      });
    });
  });
});
