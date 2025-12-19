/**
 * Gemini Metrics Windows Compatibility Tests
 *
 * Validates that Gemini metrics adapter works correctly on Windows paths
 * with backslash separators.
 */

import { describe, it, expect } from 'vitest';
import { GeminiMetricsAdapter } from '../gemini.metrics.js';
import { GeminiPluginMetadata } from '../gemini.plugin.js';

describe('GeminiMetricsAdapter - Windows Compatibility', () => {
  const adapter = new GeminiMetricsAdapter(GeminiPluginMetadata);

  describe('matchesSessionPattern', () => {
    it('should match valid Unix/Mac path', () => {
      const path = '/Users/john/.gemini/tmp/abc123/chats/session-2025-12-17T11-51-e5279324.json';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should match valid Windows path', () => {
      const path = 'C:\\Users\\john\\.gemini\\tmp\\abc123\\chats\\session-2025-12-17T11-51-e5279324.json';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should match valid Windows path with UNC prefix', () => {
      const path = '\\\\server\\share\\.gemini\\tmp\\abc123\\chats\\session-2025-12-17T11-51-e5279324.json';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should reject path missing tmp directory', () => {
      const path = '/Users/john/.gemini/chats/session-2025-12-17T11-51-e5279324.json';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });

    it('should reject path missing chats directory', () => {
      const path = '/Users/john/.gemini/tmp/abc123/session-2025-12-17T11-51-e5279324.json';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });

    it('should reject invalid filename pattern', () => {
      const path = '/Users/john/.gemini/tmp/abc123/chats/invalid-filename.json';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });

    it('should reject wrong file extension', () => {
      const path = '/Users/john/.gemini/tmp/abc123/chats/session-2025-12-17T11-51-e5279324.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });
  });

  describe('extractSessionId', () => {
    it('should extract session ID from Unix/Mac path', () => {
      const path = '/Users/john/.gemini/tmp/abc123/chats/session-2025-12-17T11-51-e5279324.json';
      expect(adapter.extractSessionId(path)).toBe('2025-12-17T11-51-e5279324');
    });

    it('should extract session ID from Windows path', () => {
      const path = 'C:\\Users\\john\\.gemini\\tmp\\abc123\\chats\\session-2025-12-17T11-51-e5279324.json';
      expect(adapter.extractSessionId(path)).toBe('2025-12-17T11-51-e5279324');
    });

    it('should extract session ID with different hex IDs', () => {
      const path = '/Users/john/.gemini/tmp/abc123/chats/session-2025-11-26T18-04-0f3fa3a6.json';
      expect(adapter.extractSessionId(path)).toBe('2025-11-26T18-04-0f3fa3a6');
    });
  });
});
