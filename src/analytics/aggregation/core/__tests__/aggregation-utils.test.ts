/**
 * Tests for aggregation utilities
 */

import { describe, it, expect } from 'vitest';
import { normalizeModelName } from '../aggregation-utils.js';

describe('normalizeModelName', () => {
  describe('AWS Bedrock Converse format', () => {
    it('should normalize converse/global.anthropic format', () => {
      const input = 'converse/global.anthropic.claude-haiku-4-5-20251001-v1:0';
      const expected = 'claude-haiku-4-5-20251001';
      expect(normalizeModelName(input)).toBe(expected);
    });

    it('should normalize converse/eu.anthropic format', () => {
      const input = 'converse/eu.anthropic.claude-sonnet-4-5-20250929-v1:0';
      const expected = 'claude-sonnet-4-5-20250929';
      expect(normalizeModelName(input)).toBe(expected);
    });

    it('should normalize converse/us-east-1.anthropic format', () => {
      const input = 'converse/us-east-1.anthropic.claude-opus-4-20250514-v1:0';
      const expected = 'claude-opus-4-20250514';
      expect(normalizeModelName(input)).toBe(expected);
    });
  });

  describe('AWS Bedrock Direct format (without converse prefix)', () => {
    it('should normalize eu.anthropic format', () => {
      const input = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
      const expected = 'claude-haiku-4-5-20251001';
      expect(normalizeModelName(input)).toBe(expected);
    });

    it('should normalize us-east-1.anthropic format', () => {
      const input = 'us-east-1.anthropic.claude-opus-4-20250514-v1:0';
      const expected = 'claude-opus-4-20250514';
      expect(normalizeModelName(input)).toBe(expected);
    });

    it('should normalize global.anthropic format', () => {
      const input = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';
      const expected = 'claude-sonnet-4-5-20250929';
      expect(normalizeModelName(input)).toBe(expected);
    });

    it('should handle different version formats', () => {
      const input = 'eu.anthropic.claude-haiku-4-5-20251001-v2:1';
      const expected = 'claude-haiku-4-5-20251001';
      expect(normalizeModelName(input)).toBe(expected);
    });
  });

  describe('Standard format (unchanged)', () => {
    it('should not modify standard Claude model names', () => {
      const input = 'claude-sonnet-4-5-20250929';
      expect(normalizeModelName(input)).toBe(input);
    });

    it('should not modify OpenAI model names', () => {
      const input = 'gpt-4.1-turbo';
      expect(normalizeModelName(input)).toBe(input);
    });

    it('should not modify Google model names', () => {
      const input = 'gemini-1.5-pro';
      expect(normalizeModelName(input)).toBe(input);
    });

    it('should not modify custom model names', () => {
      const input = 'my-custom-model-v1';
      expect(normalizeModelName(input)).toBe(input);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty string', () => {
      expect(normalizeModelName('')).toBe('');
    });

    it('should handle model names without version suffix', () => {
      const input = 'eu.anthropic.claude-haiku-4-5-20251001';
      expect(normalizeModelName(input)).toBe(input);
    });

    it('should not normalize partial Bedrock format without region', () => {
      // Missing region prefix, should return unchanged
      const input = 'anthropic.claude-sonnet-v1:0';
      expect(normalizeModelName(input)).toBe(input);
    });
  });
});
