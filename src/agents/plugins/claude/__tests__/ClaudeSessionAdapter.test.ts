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
            id: 'msg_api_1',
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
            id: 'msg_api_2',
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

      expect(parsed.metrics).toBeDefined();
      expect(parsed.messages).toHaveLength(3);
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

      expect(parsed.metrics).toBeDefined();
    });

    it('drops api-request-blob lines before counting', async () => {
      const sessionFile = join(tempDir, 'blob-session.jsonl');
      const readUse = { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'test.ts' } };
      const blob = (role: string, content: unknown) =>
        ({ type: 'api-request-blob', sessionId: 'session-blob', hash: 'h', message: { role, content } });
      const messages = [
        {
          type: 'user',
          uuid: 'msg-1',
          sessionId: 'session-blob',
          timestamp: '2024-01-01T00:00:00Z',
          message: { role: 'user', content: '<command-message>probe</command-message>\n<command-name>/probe</command-name>' }
        },
        blob('user', '<command-message>probe</command-message>\n<command-name>/probe</command-name>'),
        {
          type: 'assistant',
          uuid: 'msg-2',
          sessionId: 'session-blob',
          timestamp: '2024-01-01T00:00:01Z',
          message: { role: 'assistant', content: [readUse] }
        },
        blob('assistant', [readUse])
      ];

      await writeJSONLAtomic(sessionFile, messages);

      const parsed = await adapter.parseSessionFile(sessionFile, 'codemie-session-blob');

      expect(parsed.messages.map((m) => (m as { type: string }).type)).toEqual(['user', 'assistant']);
      expect(parsed.metrics?.tools?.Read).toBe(1);
    });

    describe('re-written lines', () => {
      const line = (type: string, uuid: string, timestamp: string, extra: Record<string, unknown> = {}) => ({
        type,
        uuid,
        sessionId: 'session-rewrite',
        timestamp,
        ...(type === 'user' || type === 'assistant' ? { message: { role: type, content: `${uuid} text` } } : {}),
        ...extra
      });
      const uuids = (lines: unknown[] | undefined) => (lines ?? []).map((m) => (m as { uuid: string }).uuid);
      const stamp = (lines: unknown[] | undefined, uuid: string) =>
        (lines ?? []).find((m) => (m as { uuid: string }).uuid === uuid) as { timestamp: string };

      it('keeps head lines re-written after compact_boundary at their first position in conversationMessages', async () => {
        const sessionFile = join(tempDir, 'compact-rewrite.jsonl');
        await writeJSONLAtomic(sessionFile, [
          line('user', 'u1', '2024-01-01T00:00:00Z'),
          line('assistant', 'a1', '2024-01-01T00:00:01Z'),
          line('system', 'cb', '2024-01-01T00:01:00Z', { subtype: 'compact_boundary' }),
          line('user', 'u1', '2024-01-01T00:01:01Z'),
          line('assistant', 'a1', '2024-01-01T00:01:02Z'),
          line('user', 'u2', '2024-01-01T00:02:00Z'),
          line('assistant', 'a2', '2024-01-01T00:02:01Z')
        ]);

        const parsed = await adapter.parseSessionFile(sessionFile, 'codemie-session-compact');

        expect(uuids(parsed.messages)).toEqual(['cb', 'u1', 'a1', 'u2', 'a2']);
        expect(uuids(parsed.conversationMessages)).toEqual(['u1', 'a1', 'cb', 'u2', 'a2']);
      });

      it('keeps the later copy of a Desktop init re-write in both messages and conversationMessages', async () => {
        const sessionFile = join(tempDir, 'init-rewrite.jsonl');
        await writeJSONLAtomic(sessionFile, [
          line('user', 'u1', '2024-01-01T00:00:00Z'),
          line('system', 's1', '2024-01-01T00:00:01Z', { subtype: 'init' }),
          line('user', 'u1', '2024-01-01T00:00:02Z'),
          line('assistant', 'a1', '2024-01-01T00:00:03Z')
        ]);

        const parsed = await adapter.parseSessionFile(sessionFile, 'codemie-session-init');

        expect(uuids(parsed.messages)).toEqual(['s1', 'u1', 'a1']);
        expect(stamp(parsed.messages, 'u1').timestamp).toBe('2024-01-01T00:00:02Z');
        expect(uuids(parsed.conversationMessages)).toEqual(['s1', 'u1', 'a1']);
        expect(stamp(parsed.conversationMessages, 'u1').timestamp).toBe('2024-01-01T00:00:02Z');
      });
    });
  });
});
