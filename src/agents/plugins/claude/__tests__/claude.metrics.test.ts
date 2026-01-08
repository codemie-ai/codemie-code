/**
 * Claude Metrics Adapter - Cross-Platform Path Detection Tests
 *
 * Tests UUID validation and path matching for Windows, macOS, and Linux
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeMetricsAdapter } from '../claude.metrics.js';
import type { AgentMetadata } from '../../core/types.js';

describe('ClaudeMetricsAdapter - Cross-Platform Path Detection', () => {
  let adapter: ClaudeMetricsAdapter;

  // Mock metadata matching ClaudePluginMetadata structure
  const mockMetadata: AgentMetadata = {
    name: 'claude',
    displayName: 'Claude Code',
    description: 'Test',
    npmPackage: '@anthropic-ai/claude-code',
    cliCommand: 'claude',
    dataPaths: {
      home: '.claude',
      sessions: 'projects',
      history: 'history.jsonl'
    },
    envMapping: {
      baseUrl: ['ANTHROPIC_BASE_URL'],
      apiKey: ['ANTHROPIC_AUTH_TOKEN'],
      model: ['ANTHROPIC_MODEL']
    },
    supportedProviders: ['litellm', 'ai-run-sso'],
    blockedModelPatterns: []
  };

  beforeEach(() => {
    adapter = new ClaudeMetricsAdapter('claude', mockMetadata);
  });

  describe('Adapter Configuration', () => {
    it('should use hash-based watermark strategy', () => {
      expect(adapter.getWatermarkStrategy()).toBe('hash');
    });

    it('should have 500ms initialization delay', () => {
      expect(adapter.getInitDelay()).toBe(500);
    });

    it('should detect correct data paths', () => {
      const dataPaths = adapter.getDataPaths();
      expect(dataPaths.sessionsDir).toContain('.claude');
      expect(dataPaths.sessionsDir).toContain('projects');
      expect(dataPaths.settingsDir).toContain('.claude');
    });
  });

  describe('UUID Validation', () => {
    it('should accept valid UUID v4 with lowercase hex', () => {
      const path = '/home/user/.claude/projects/abc123/f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should accept valid UUID with uppercase hex', () => {
      const path = '/home/user/.claude/projects/abc123/F52D1386-9D4C-4671-A31E-62DD6600A759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should accept valid UUID with mixed case hex', () => {
      const path = '/home/user/.claude/projects/abc123/f52d1386-9D4C-4671-a31e-62DD6600A759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should reject invalid UUID format - missing segment', () => {
      const path = '/home/user/.claude/projects/abc123/f52d1386-9d4c-4671-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });

    it('should reject invalid UUID format - wrong segment length', () => {
      const path = '/home/user/.claude/projects/abc123/f52d1386-9d4c-4671-a31e-62dd6600a7591.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });

    it('should reject non-hexadecimal characters in UUID', () => {
      const path = '/home/user/.claude/projects/abc123/g52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });
  });

  describe('macOS/Linux Path Detection', () => {
    it('should match valid session file in home directory', () => {
      const path = '/Users/john/.claude/projects/abc123/f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should match session file with nested project hash', () => {
      const path = '/home/user/.claude/projects/project-hash-abc/f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should reject file without .claude directory', () => {
      const path = '/home/user/projects/abc123/f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });

    it('should reject file without projects directory', () => {
      const path = '/home/user/.claude/abc123/f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });

    it('should reject file without project hash directory', () => {
      const path = '/home/user/.claude/projects/f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });

    it('should reject agent-* files (sub-agents)', () => {
      const path = '/home/user/.claude/projects/abc123/agent-f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });

    it('should reject files with wrong extension', () => {
      const path = '/home/user/.claude/projects/abc123/f52d1386-9d4c-4671-a31e-62dd6600a759.json';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });
  });

  describe('Windows Path Detection (proper backslash format)', () => {
    // These tests use proper Windows paths with backslashes
    // The adapter uses cross-platform path utilities that normalize separators
    // This allows it to handle both Windows and Unix paths on any platform

    it('should handle Windows drive letter paths with backslashes', () => {
      const path = 'C:\\Users\\john\\.claude\\projects\\abc123\\f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should handle different drive letters', () => {
      const path = 'D:\\Projects\\company-repo\\.claude\\projects\\project-cli\\f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should handle deeply nested Windows paths', () => {
      const path = 'C:\\Projects\\team\\repo\\.claude\\projects\\user-hash-abc\\f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should reject path without .claude directory', () => {
      const path = 'C:\\Users\\john\\projects\\abc123\\f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });

    it('should reject path without projects directory', () => {
      const path = 'C:\\Users\\john\\.claude\\abc123\\f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });

    it('should reject agent-* files', () => {
      const path = 'C:\\Users\\john\\.claude\\projects\\abc123\\agent-f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });

    it('should reject files with wrong extension', () => {
      const path = 'C:\\Users\\john\\.claude\\projects\\abc123\\f52d1386-9d4c-4671-a31e-62dd6600a759.json';
      expect(adapter.matchesSessionPattern(path)).toBe(false);
    });
  });

  describe('Edge Cases and Special Characters', () => {
    it('should handle forward slash paths (mixed separator style)', () => {
      // Some tools may generate Windows paths with forward slashes
      const path = 'C:/Users/john/.claude/projects/abc123/f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should reject agent files regardless of separator style', () => {
      const pathUnix = '/home/user/.claude/projects/abc/agent-123.jsonl';
      const pathWindows = 'C:\\Users\\user\\.claude\\projects\\abc\\agent-123.jsonl';

      expect(adapter.matchesSessionPattern(pathUnix)).toBe(false);
      expect(adapter.matchesSessionPattern(pathWindows)).toBe(false);
    });

    it('should handle project hash with special characters', () => {
      // Project hashes can contain various characters including hyphens, underscores, etc.
      const path = '/home/user/.claude/projects/user-hash-123_abc/f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });

    it('should handle deeply nested absolute paths', () => {
      const path = '/very/deeply/nested/path/to/home/.claude/projects/hash123/f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      expect(adapter.matchesSessionPattern(path)).toBe(true);
    });
  });

  describe('extractSessionId', () => {
    it('should extract UUID from Unix path', () => {
      const path = '/home/user/.claude/projects/abc/f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      const sessionId = adapter.extractSessionId(path);
      expect(sessionId).toBe('f52d1386-9d4c-4671-a31e-62dd6600a759');
    });

    it('should extract UUID from Windows path with backslashes', () => {
      const path = 'C:\\Users\\john\\.claude\\projects\\abc\\f52d1386-9d4c-4671-a31e-62dd6600a759.jsonl';
      const sessionId = adapter.extractSessionId(path);
      expect(sessionId).toBe('f52d1386-9d4c-4671-a31e-62dd6600a759');
    });

    it('should extract agent ID from agent file (Unix)', () => {
      const path = '/home/user/.claude/projects/abc/agent-abc123de.jsonl';
      const sessionId = adapter.extractSessionId(path);
      expect(sessionId).toBe('agent-abc123de');
    });

    it('should extract agent ID from agent file (Windows)', () => {
      const path = 'C:\\Users\\john\\.claude\\projects\\abc\\agent-abc123de.jsonl';
      const sessionId = adapter.extractSessionId(path);
      expect(sessionId).toBe('agent-abc123de');
    });

    it('should handle empty or invalid paths', () => {
      expect(adapter.extractSessionId('')).toBe('');
      expect(adapter.extractSessionId('invalid')).toBe('');
      expect(adapter.extractSessionId('/no/extension')).toBe('');
    });
  });
});
