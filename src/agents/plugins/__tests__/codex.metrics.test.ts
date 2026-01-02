/**
 * Codex Metrics Adapter - Cross-Platform Path Detection Tests
 *
 * Tests session pattern matching with date filtering and path handling for Windows, macOS, and Linux
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CodexMetricsAdapter } from '../codex.metrics.js';
import type { AgentMetadata } from '../../core/types.js';

describe('CodexMetricsAdapter - Cross-Platform Path Detection', () => {
  let adapter: CodexMetricsAdapter;

  // Mock metadata matching CodexPluginMetadata structure
  const mockMetadata: AgentMetadata = {
    name: 'codex',
    displayName: 'Codex',
    description: 'Test',
    npmPackage: '@openai/codex',
    cliCommand: 'codex',
    dataPaths: {
      home: '.codex',
      sessions: 'sessions',
      user_prompts: 'history.jsonl'
    },
    envMapping: {
      baseUrl: ['OPENAI_API_BASE', 'OPENAI_BASE_URL'],
      apiKey: ['OPENAI_API_KEY'],
      model: ['OPENAI_MODEL', 'CODEX_MODEL']
    },
    supportedProviders: ['ollama', 'litellm', 'ai-run-sso'],
    blockedModelPatterns: []
  };

  beforeEach(() => {
    adapter = new CodexMetricsAdapter(mockMetadata);
  });

  describe('Session Filename Pattern', () => {
    it('should accept valid rollout filename', () => {
      const path = '/home/user/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(true);
    });

    it('should accept different UUID formats', () => {
      const path = '/home/user/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09-abc123de-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(true);
    });

    it('should reject invalid filename pattern - missing rollout prefix', () => {
      const path = '/home/user/.codex/sessions/2026/01/02/session-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(false);
    });

    it('should reject invalid date format', () => {
      const path = '/home/user/.codex/sessions/2026/01/02/rollout-2026-1-2T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(false);
    });

    it('should reject invalid time format', () => {
      const path = '/home/user/.codex/sessions/2026/01/02/rollout-2026-01-02T1-2-3-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(false);
    });

    it('should reject missing UUID', () => {
      const path = '/home/user/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(false);
    });

    it('should reject wrong file extension', () => {
      const path = '/home/user/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.json';
      expect(adapter.matchesSessionPattern(path, null)).toBe(false);
    });
  });

  describe('Date Filtering (Performance Optimization)', () => {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const [todayYear, todayMonth, todayDay] = today.split('-');

    it('should match today\'s session by default (no dateFilter)', () => {
      const path = `/home/user/.codex/sessions/${todayYear}/${todayMonth}/${todayDay}/rollout-${today}T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl`;
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should reject yesterday\'s session by default', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yd = yesterday.toISOString().split('T')[0];
      const [year, month, day] = yd.split('-');

      const path = `/home/user/.codex/sessions/${year}/${month}/${day}/rollout-${yd}T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl`;
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });

    it('should match specific date when dateFilter provided', () => {
      const path = '/home/user/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, '2026-01-02')).toBe(true);
    });

    it('should reject different date when dateFilter provided', () => {
      const path = '/home/user/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, '2026-01-03')).toBe(false);
    });

    it('should match all dates when dateFilter is null', () => {
      const path1 = '/home/user/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      const path2 = '/home/user/.codex/sessions/2025/12/25/rollout-2025-12-25T10-00-00-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';

      expect(adapter.matchesSessionPattern(path1, null)).toBe(true);
      expect(adapter.matchesSessionPattern(path2, null)).toBe(true);
    });
  });

  describe('macOS/Linux Path Detection', () => {
    it('should match valid session file in home directory', () => {
      const path = '/Users/john/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(true);
    });

    it('should match session file with correct date structure', () => {
      const path = '/home/user/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(true);
    });

    it('should reject file without .codex directory', () => {
      const path = '/home/user/sessions/2026/01/02/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(false);
    });

    it('should reject file without sessions directory', () => {
      const path = '/home/user/.codex/2026/01/02/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(false);
    });

    it('should reject file without date structure', () => {
      const path = '/home/user/.codex/sessions/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(false);
    });

    it('should reject incomplete date structure (missing day)', () => {
      const path = '/home/user/.codex/sessions/2026/01/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(false);
    });
  });

  describe('Windows Path Detection (proper backslash format)', () => {
    it('should handle Windows drive letter paths with backslashes', () => {
      const path = 'C:\\Users\\john\\.codex\\sessions\\2026\\01\\02\\rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(true);
    });

    it('should handle different drive letters', () => {
      const path = 'D:\\Projects\\.codex\\sessions\\2026\\01\\02\\rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(true);
    });

    it('should handle deeply nested Windows paths', () => {
      const path = 'C:\\Projects\\team\\repo\\.codex\\sessions\\2026\\01\\02\\rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(true);
    });

    it('should reject path without .codex directory', () => {
      const path = 'C:\\Users\\john\\sessions\\2026\\01\\02\\rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(false);
    });

    it('should reject path without sessions directory', () => {
      const path = 'C:\\Users\\john\\.codex\\2026\\01\\02\\rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(false);
    });

    it('should apply date filtering on Windows paths', () => {
      const path = 'C:\\Users\\john\\.codex\\sessions\\2026\\01\\02\\rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, '2026-01-02')).toBe(true);
      expect(adapter.matchesSessionPattern(path, '2026-01-03')).toBe(false);
    });
  });

  describe('Edge Cases and Special Characters', () => {
    it('should handle forward slash paths (mixed separator style)', () => {
      // Some tools may generate Windows paths with forward slashes
      const path = 'C:/Users/john/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(true);
    });

    it('should handle deeply nested absolute paths', () => {
      const path = '/very/deeply/nested/path/to/home/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      expect(adapter.matchesSessionPattern(path, null)).toBe(true);
    });

    it('should handle different year/month/day values', () => {
      const path1 = '/home/user/.codex/sessions/2025/12/31/rollout-2025-12-31T23-59-59-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      const path2 = '/home/user/.codex/sessions/2026/06/15/rollout-2026-06-15T12-00-00-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';

      expect(adapter.matchesSessionPattern(path1, null)).toBe(true);
      expect(adapter.matchesSessionPattern(path2, null)).toBe(true);
    });
  });

  describe('extractSessionId', () => {
    it('should extract UUID from Unix path', () => {
      const path = '/home/user/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      const sessionId = adapter.extractSessionId(path);
      expect(sessionId).toBe('019b7eb8-f483-71d3-ae10-1bd180168ba5');
    });

    it('should extract UUID from Windows path with backslashes', () => {
      const path = 'C:\\Users\\john\\.codex\\sessions\\2026\\01\\02\\rollout-2026-01-02T14-40-09-019b7eb8-f483-71d3-ae10-1bd180168ba5.jsonl';
      const sessionId = adapter.extractSessionId(path);
      expect(sessionId).toBe('019b7eb8-f483-71d3-ae10-1bd180168ba5');
    });

    it('should extract complex UUID', () => {
      const path = '/home/user/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09-f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      const sessionId = adapter.extractSessionId(path);
      expect(sessionId).toBe('f52d1386-9d4c-4671-a31e-62dd6600a759');
    });

    it('should handle short UUID', () => {
      const path = '/home/user/.codex/sessions/2026/01/02/rollout-2026-01-02T14-40-09-abc123de-f483-71d3-ae10-1bd180168ba5.jsonl';
      const sessionId = adapter.extractSessionId(path);
      expect(sessionId).toBe('abc123de-f483-71d3-ae10-1bd180168ba5');
    });

    it('should fallback to filename without .jsonl if no match', () => {
      const path = '/invalid/path/invalid-file.jsonl';
      const sessionId = adapter.extractSessionId(path);
      expect(sessionId).toBe('invalid-file');
    });
  });

  describe('getWatermarkStrategy', () => {
    it('should return object-based watermark strategy', () => {
      expect(adapter.getWatermarkStrategy()).toBe('object');
    });
  });

  describe('getInitDelay', () => {
    it('should return 500ms initialization delay', () => {
      expect(adapter.getInitDelay()).toBe(500);
    });
  });
});
