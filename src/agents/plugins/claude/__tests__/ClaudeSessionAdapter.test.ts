/**
 * Claude Session Adapter Unit Tests
 *
 * Tests for Claude-specific session parsing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeSessionAdapter } from '../claude.session.js';
import { ClaudePluginMetadata } from '../claude.plugin.js';
import type { ClaudeMessage } from '../claude-message-types.js';
import { writeJSONLAtomic } from '../../../../providers/plugins/sso/session/utils/jsonl-writer.js';
import { existsSync } from 'fs';

describe('ClaudeSessionAdapter', () => {
  let adapter: ClaudeSessionAdapter;
  let tempDir: string;

  beforeEach(async () => {
    adapter = new ClaudeSessionAdapter(ClaudePluginMetadata);
    tempDir = await mkdtemp(join(tmpdir(), 'claude-adapter-test-'));
  });

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('parseSessionFile', () => {
    it('should parse simple session with messages', async () => {
      const sessionFile = join(tempDir, 'test-session.jsonl');
      const messages: ClaudeMessage[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          sessionId: 'session-123',
          timestamp: '2024-01-01T00:00:00Z',
          message: {
            role: 'user',
            content: 'Hello, Claude!'
          }
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          sessionId: 'session-123',
          timestamp: '2024-01-01T00:00:01Z',
          message: {
            role: 'assistant',
            content: 'Hello! How can I help you today?',
            usage: {
              input_tokens: 10,
              output_tokens: 20
            }
          }
        }
      ];

      await writeJSONLAtomic(sessionFile, messages);

      const parsed = await adapter.parseSessionFile(sessionFile, 'codemie-session-123');

      expect(parsed.sessionId).toBe('codemie-session-123');
      expect(parsed.agentName).toBe('Claude Code');
      expect(parsed.messages).toHaveLength(2);
      expect(parsed.metadata.projectPath).toBe(sessionFile);
    });

    it('should extract token metrics', async () => {
      const sessionFile = join(tempDir, 'metrics-session.jsonl');
      const messages: ClaudeMessage[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          sessionId: 'session-metrics',
          timestamp: '2024-01-01T00:00:00Z',
          message: { role: 'user', content: 'test' }
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          sessionId: 'session-metrics',
          timestamp: '2024-01-01T00:00:01Z',
          message: {
            role: 'assistant',
            content: 'response',
            usage: {
              input_tokens: 100,
              output_tokens: 200,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 25
            }
          }
        },
        {
          type: 'assistant',
          uuid: 'msg-3',
          sessionId: 'session-metrics',
          timestamp: '2024-01-01T00:00:02Z',
          message: {
            role: 'assistant',
            content: 'another response',
            usage: {
              input_tokens: 150,
              output_tokens: 250
            }
          }
        }
      ];

      await writeJSONLAtomic(sessionFile, messages);

      const parsed = await adapter.parseSessionFile(sessionFile, 'codemie-session-metrics');

      expect(parsed.metrics?.tokens?.input).toBe(250);  // 100 + 150
      expect(parsed.metrics?.tokens?.output).toBe(450);  // 200 + 250
      expect(parsed.metrics?.tokens?.cacheRead).toBe(50);
      expect(parsed.metrics?.tokens?.cacheWrite).toBe(25);
    });

    it('should extract tool usage', async () => {
      const sessionFile = join(tempDir, 'tools-session.jsonl');
      const messages: ClaudeMessage[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          sessionId: 'session-tools',
          timestamp: '2024-01-01T00:00:00Z',
          message: { role: 'user', content: 'read a file' }
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          sessionId: 'session-tools',
          timestamp: '2024-01-01T00:00:01Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will read the file' },
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'test.ts' } }
            ]
          }
        },
        {
          type: 'assistant',
          uuid: 'msg-3',
          sessionId: 'session-tools',
          timestamp: '2024-01-01T00:00:02Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { path: 'test.ts' } },
              { type: 'tool_use', id: 'tool-3', name: 'Read', input: { path: 'other.ts' } }
            ]
          }
        }
      ];

      await writeJSONLAtomic(sessionFile, messages);

      const parsed = await adapter.parseSessionFile(sessionFile, 'codemie-session-tools');

      expect(parsed.metrics?.tools?.Read).toBe(2);
      expect(parsed.metrics?.tools?.Edit).toBe(1);
    });

    it('should track tool success and failure', async () => {
      const sessionFile = join(tempDir, 'tool-status-session.jsonl');
      const messages: ClaudeMessage[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          sessionId: 'session-tool-status',
          timestamp: '2024-01-01T00:00:00Z',
          message: { role: 'user', content: 'test' }
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          sessionId: 'session-tool-status',
          timestamp: '2024-01-01T00:00:01Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'test.ts' } },
              { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { path: 'test.ts' } },
              { type: 'tool_use', id: 'tool-3', name: 'Read', input: { path: 'bad.ts' } }
            ]
          }
        },
        {
          type: 'user',
          uuid: 'msg-3',
          sessionId: 'session-tool-status',
          timestamp: '2024-01-01T00:00:02Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'file content', isError: false },
              { type: 'tool_result', tool_use_id: 'tool-2', content: 'success', isError: false },
              { type: 'tool_result', tool_use_id: 'tool-3', content: 'file not found', isError: true }
            ]
          }
        }
      ];

      await writeJSONLAtomic(sessionFile, messages);

      const parsed = await adapter.parseSessionFile(sessionFile, 'codemie-session-tool-status');

      expect(parsed.metrics?.toolStatus?.Read).toEqual({ success: 1, failure: 1 });
      expect(parsed.metrics?.toolStatus?.Edit).toEqual({ success: 1, failure: 0 });
    });

    it('should handle empty session file gracefully', async () => {
      const sessionFile = join(tempDir, 'empty-session.jsonl');
      await writeJSONLAtomic(sessionFile, []);

      const parsed = await adapter.parseSessionFile(sessionFile, 'codemie-session-empty');

      expect(parsed.sessionId).toBe('codemie-session-empty');
      expect(parsed.messages).toEqual([]);
      expect(parsed.agentName).toBe('Claude Code');
    });

    it('should handle file-history-snapshot as first line', async () => {
      const sessionFile = join(tempDir, 'snapshot-first-session.jsonl');
      const messages: any[] = [
        // First line: file-history-snapshot without sessionId
        {
          type: 'file-history-snapshot',
          messageId: 'snapshot-1',
          snapshot: {
            messageId: 'snapshot-1',
            trackedFileBackups: {},
            timestamp: '2024-01-01T00:00:00Z'
          },
          isSnapshotUpdate: false
        },
        // Second line: actual message with sessionId (only needs to be in one message)
        {
          type: 'user',
          uuid: 'msg-1',
          sessionId: 'session-123',
          timestamp: '2024-01-01T00:00:01Z',
          message: { role: 'user', content: 'Hello' }
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          timestamp: '2024-01-01T00:00:02Z',
          message: {
            role: 'assistant',
            content: 'Hi there!',
            usage: { input_tokens: 10, output_tokens: 20 }
          }
        }
      ];

      await writeJSONLAtomic(sessionFile, messages);

      const parsed = await adapter.parseSessionFile(sessionFile, 'codemie-session-snapshot');

      expect(parsed.sessionId).toBe('codemie-session-snapshot');
      expect(parsed.messages).toHaveLength(3);
      expect(parsed.metadata.createdAt).toBe('2024-01-01T00:00:01Z');
    });


    it('should handle messages without usage data', async () => {
      const sessionFile = join(tempDir, 'no-usage-session.jsonl');
      const messages: ClaudeMessage[] = [
        {
          type: 'user',
          uuid: 'msg-1',
          sessionId: 'session-no-usage',
          timestamp: '2024-01-01T00:00:00Z',
          message: { role: 'user', content: 'test' }
        },
        {
          type: 'assistant',
          uuid: 'msg-2',
          sessionId: 'session-no-usage',
          timestamp: '2024-01-01T00:00:01Z',
          message: { role: 'assistant', content: 'response' }
        }
      ];

      await writeJSONLAtomic(sessionFile, messages);

      const parsed = await adapter.parseSessionFile(sessionFile, 'codemie-session-no-usage');

      expect(parsed.metrics?.tokens?.input).toBe(0);
      expect(parsed.metrics?.tokens?.output).toBe(0);
    });
  });
});
