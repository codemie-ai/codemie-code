/**
 * Unit Tests: Claude Conversations Transformer (Refactored)
 *
 * Tests stateless transformer with sync state for incremental processing
 */

import { describe, it, expect } from 'vitest';
import { transformMessages } from '../claude.conversations-transformer.js';
import type { ClaudeMessage } from '../claude.conversations-types.js';
import type { SyncState } from '../claude.conversations-transformer.js';

describe('transformMessages - Refactored (Stateless with Sync State)', () => {
  const ASSISTANT_ID = 'test-assistant-id';
  const AGENT_NAME = 'Claude Code';

  describe('New Turn Detection', () => {
    it('should process first user message as new turn', () => {
      const messages: ClaudeMessage[] = [
        {
          uuid: 'user-1',
          type: 'user',
          timestamp: '2026-01-09T12:00:00.000Z',
          sessionId: 'test-session',
          message: {
            role: 'user',
            content: 'hello'
          }
        },
        {
          uuid: 'assistant-1',
          type: 'assistant',
          timestamp: '2026-01-09T12:00:05.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi there!' }],
            usage: { input_tokens: 10, output_tokens: 5 }
          }
        }
      ];

      const syncState: SyncState = {
        lastSyncedMessageUuid: undefined,
        lastSyncedHistoryIndex: -1
      };

      const result = transformMessages(messages, syncState, ASSISTANT_ID, AGENT_NAME);

      expect(result.isTurnContinuation).toBe(false);
      expect(result.currentHistoryIndex).toBe(0);
      expect(result.history).toHaveLength(2);
      expect(result.history[0].role).toBe('User');
      expect(result.history[0].history_index).toBe(0);
      expect(result.history[1].role).toBe('Assistant');
      expect(result.history[1].history_index).toBe(0);
      expect(result.lastProcessedMessageUuid).toBe('assistant-1');
    });

    it('should increment history index for second turn', () => {
      const messages: ClaudeMessage[] = [
        {
          uuid: 'user-1',
          type: 'user',
          timestamp: '2026-01-09T12:00:00.000Z',
          sessionId: 'test-session',
          message: { role: 'user', content: 'first' }
        },
        {
          uuid: 'assistant-1',
          type: 'assistant',
          timestamp: '2026-01-09T12:00:05.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'response 1' }],
            usage: { input_tokens: 10, output_tokens: 5 }
          }
        },
        {
          uuid: 'user-2',
          type: 'user',
          timestamp: '2026-01-09T12:01:00.000Z',
          sessionId: 'test-session',
          message: { role: 'user', content: 'second' }
        },
        {
          uuid: 'assistant-2',
          type: 'assistant',
          timestamp: '2026-01-09T12:01:05.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'response 2' }],
            usage: { input_tokens: 15, output_tokens: 8 }
          }
        }
      ];

      // Sync turn 1
      const syncState1: SyncState = {
        lastSyncedMessageUuid: undefined,
        lastSyncedHistoryIndex: -1
      };
      const result1 = transformMessages(messages.slice(0, 2), syncState1, ASSISTANT_ID, AGENT_NAME);
      expect(result1.currentHistoryIndex).toBe(0);

      // Sync turn 2
      const syncState2: SyncState = {
        lastSyncedMessageUuid: result1.lastProcessedMessageUuid,
        lastSyncedHistoryIndex: result1.currentHistoryIndex
      };
      const result2 = transformMessages(messages, syncState2, ASSISTANT_ID, AGENT_NAME);

      expect(result2.isTurnContinuation).toBe(false);
      expect(result2.currentHistoryIndex).toBe(1);
      expect(result2.history[0].history_index).toBe(1);
      expect(result2.history[1].history_index).toBe(1);
    });
  });

  describe('Turn Continuation Detection', () => {
    it('should detect tool result as turn continuation', () => {
      const messages: ClaudeMessage[] = [
        {
          uuid: 'user-1',
          type: 'user',
          timestamp: '2026-01-09T12:00:00.000Z',
          sessionId: 'test-session',
          message: { role: 'user', content: 'read file' }
        },
        {
          uuid: 'assistant-1',
          type: 'assistant',
          timestamp: '2026-01-09T12:00:05.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Read',
                input: { file_path: '/test.ts' }
              }
            ],
            usage: { input_tokens: 100, output_tokens: 20 }
          }
        }
      ];

      // First sync
      const syncState1: SyncState = {
        lastSyncedMessageUuid: undefined,
        lastSyncedHistoryIndex: -1
      };
      const result1 = transformMessages(messages, syncState1, ASSISTANT_ID, AGENT_NAME);
      expect(result1.currentHistoryIndex).toBe(0);

      // Add tool result
      const messagesWithResult: ClaudeMessage[] = [
        ...messages,
        {
          uuid: 'tool-result-1',
          type: 'user',
          timestamp: '2026-01-09T12:00:06.000Z',
          sessionId: 'test-session',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'file contents'
              }
            ]
          }
        },
        {
          uuid: 'assistant-2',
          type: 'assistant',
          timestamp: '2026-01-09T12:00:10.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Here is the file' }],
            usage: { input_tokens: 50, output_tokens: 10 }
          }
        }
      ];

      // Second sync (with tool result) should be continuation
      const syncState2: SyncState = {
        lastSyncedMessageUuid: result1.lastProcessedMessageUuid,
        lastSyncedHistoryIndex: result1.currentHistoryIndex
      };
      const result2 = transformMessages(messagesWithResult, syncState2, ASSISTANT_ID, AGENT_NAME);

      expect(result2.isTurnContinuation).toBe(true);
      expect(result2.currentHistoryIndex).toBe(0); // Same history index
      expect(result2.history).toHaveLength(1); // Only Assistant entry
      expect(result2.history[0].role).toBe('Assistant');
    });
  });

  describe('Incremental Processing', () => {
    it('should only process messages after lastSyncedMessageUuid', () => {
      const messages: ClaudeMessage[] = [
        {
          uuid: 'user-1',
          type: 'user',
          timestamp: '2026-01-09T12:00:00.000Z',
          sessionId: 'test-session',
          message: { role: 'user', content: 'first' }
        },
        {
          uuid: 'assistant-1',
          type: 'assistant',
          timestamp: '2026-01-09T12:00:05.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'response' }],
            usage: { input_tokens: 10, output_tokens: 5 }
          }
        }
      ];

      // Simulate already synced
      const syncState: SyncState = {
        lastSyncedMessageUuid: 'assistant-1',
        lastSyncedHistoryIndex: 0
      };

      const result = transformMessages(messages, syncState, ASSISTANT_ID, AGENT_NAME);

      // No new messages to process
      expect(result.history).toHaveLength(0);
      expect(result.lastProcessedMessageUuid).toBe('assistant-1');
      expect(result.currentHistoryIndex).toBe(0);
    });

    it('should process only new messages added incrementally', () => {
      const initialMessages: ClaudeMessage[] = [
        {
          uuid: 'user-1',
          type: 'user',
          timestamp: '2026-01-09T12:00:00.000Z',
          sessionId: 'test-session',
          message: { role: 'user', content: 'hello' }
        }
      ];

      // First sync
      const syncState1: SyncState = {
        lastSyncedMessageUuid: undefined,
        lastSyncedHistoryIndex: -1
      };
      const result1 = transformMessages(initialMessages, syncState1, ASSISTANT_ID, AGENT_NAME);
      expect(result1.history).toHaveLength(1); // Just User

      // Add assistant response
      const messagesWithResponse: ClaudeMessage[] = [
        ...initialMessages,
        {
          uuid: 'assistant-1',
          type: 'assistant',
          timestamp: '2026-01-09T12:00:05.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi!' }],
            usage: { input_tokens: 10, output_tokens: 5 }
          }
        }
      ];

      // Second sync should process only assistant message
      const syncState2: SyncState = {
        lastSyncedMessageUuid: result1.lastProcessedMessageUuid,
        lastSyncedHistoryIndex: result1.currentHistoryIndex
      };
      const result2 = transformMessages(messagesWithResponse, syncState2, ASSISTANT_ID, AGENT_NAME);

      expect(result2.isTurnContinuation).toBe(true);
      expect(result2.history).toHaveLength(1); // Only Assistant
      expect(result2.history[0].role).toBe('Assistant');
    });
  });

  describe('System Message Filtering', () => {
    it('should filter system messages from output', () => {
      const messages: ClaudeMessage[] = [
        {
          uuid: 'user-1',
          type: 'user',
          timestamp: '2026-01-09T12:00:00.000Z',
          sessionId: 'test-session',
          message: { role: 'user', content: 'test' }
        },
        {
          uuid: 'system-1',
          type: 'user',
          timestamp: '2026-01-09T12:00:01.000Z',
          sessionId: 'test-session',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '[Request interrupted by user for tool use]'
              }
            ]
          }
        },
        {
          uuid: 'assistant-1',
          type: 'assistant',
          timestamp: '2026-01-09T12:00:05.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'response' }],
            usage: { input_tokens: 10, output_tokens: 5 }
          }
        }
      ];

      const syncState: SyncState = {
        lastSyncedMessageUuid: undefined,
        lastSyncedHistoryIndex: -1
      };

      const result = transformMessages(messages, syncState, ASSISTANT_ID, AGENT_NAME);

      // Should have User + Assistant, system message filtered
      expect(result.history).toHaveLength(2);
      expect(result.history[0].message).not.toContain('[Request interrupted');
    });
  });

  describe('Empty Message Handling', () => {
    it('should skip empty assistant with no thoughts', () => {
      const messages: ClaudeMessage[] = [
        {
          uuid: 'user-1',
          type: 'user',
          timestamp: '2026-01-09T12:00:00.000Z',
          sessionId: 'test-session',
          message: { role: 'user', content: 'test' }
        },
        {
          uuid: 'assistant-1',
          type: 'assistant',
          timestamp: '2026-01-09T12:00:05.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [],
            usage: { input_tokens: 10, output_tokens: 0 }
          }
        }
      ];

      const syncState: SyncState = {
        lastSyncedMessageUuid: undefined,
        lastSyncedHistoryIndex: -1
      };

      const result = transformMessages(messages, syncState, ASSISTANT_ID, AGENT_NAME);

      // Should only have User entry
      expect(result.history).toHaveLength(1);
      expect(result.history[0].role).toBe('User');
    });

    it('should include assistant with tool calls and results', () => {
      const messages: ClaudeMessage[] = [
        {
          uuid: 'user-1',
          type: 'user',
          timestamp: '2026-01-09T12:00:00.000Z',
          sessionId: 'test-session',
          message: { role: 'user', content: 'read file' }
        },
        {
          uuid: 'assistant-1',
          type: 'assistant',
          timestamp: '2026-01-09T12:00:05.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Read',
                input: { file_path: '/test.ts' }
              }
            ],
            usage: { input_tokens: 100, output_tokens: 20 }
          }
        },
        {
          uuid: 'tool-result-1',
          type: 'user',
          timestamp: '2026-01-09T12:00:06.000Z',
          sessionId: 'test-session',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'file contents here'
              }
            ]
          }
        },
        {
          uuid: 'assistant-2',
          type: 'assistant',
          timestamp: '2026-01-09T12:00:10.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [],
            usage: { input_tokens: 50, output_tokens: 5 }
          }
        }
      ];

      const syncState: SyncState = {
        lastSyncedMessageUuid: undefined,
        lastSyncedHistoryIndex: -1
      };

      const result = transformMessages(messages, syncState, ASSISTANT_ID, AGENT_NAME);

      // Should have both User and Assistant
      expect(result.history).toHaveLength(2);
      expect(result.history[1].role).toBe('Assistant');
      // Should have thoughts (tool call + result)
      expect(result.history[1].thoughts).toBeDefined();
      expect(result.history[1].thoughts!.length).toBeGreaterThan(0);
    });
  });

  describe('Token Aggregation', () => {
    it('should aggregate tokens from multiple assistant messages in same turn', () => {
      const messages: ClaudeMessage[] = [
        {
          uuid: 'user-1',
          type: 'user',
          timestamp: '2026-01-09T12:00:00.000Z',
          sessionId: 'test-session',
          message: { role: 'user', content: 'test' }
        },
        {
          uuid: 'assistant-1',
          type: 'assistant',
          timestamp: '2026-01-09T12:00:02.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'thinking...' }],
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 1000,
              cache_read_input_tokens: 500
            }
          }
        },
        {
          uuid: 'assistant-2',
          type: 'assistant',
          timestamp: '2026-01-09T12:00:05.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'final response' }],
            usage: {
              input_tokens: 200,
              output_tokens: 100,
              cache_creation_input_tokens: 2000,
              cache_read_input_tokens: 1000
            }
          }
        }
      ];

      const syncState: SyncState = {
        lastSyncedMessageUuid: undefined,
        lastSyncedHistoryIndex: -1
      };

      const result = transformMessages(messages, syncState, ASSISTANT_ID, AGENT_NAME);

      const assistantEntry = result.history.find(h => h.role === 'Assistant');
      expect(assistantEntry).toBeDefined();
      expect(assistantEntry!.input_tokens).toBe(300); // 100 + 200
      expect(assistantEntry!.output_tokens).toBe(150); // 50 + 100
      expect(assistantEntry!.cache_creation_input_tokens).toBe(3000); // 1000 + 2000
      expect(assistantEntry!.cache_read_input_tokens).toBe(1500); // 500 + 1000
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty messages array', () => {
      const syncState: SyncState = {
        lastSyncedMessageUuid: undefined,
        lastSyncedHistoryIndex: -1
      };

      const result = transformMessages([], syncState, ASSISTANT_ID, AGENT_NAME);

      expect(result.history).toHaveLength(0);
      expect(result.isTurnContinuation).toBe(false);
      expect(result.currentHistoryIndex).toBe(-1);
      expect(result.lastProcessedMessageUuid).toBe('');
    });

    it('should handle messages without uuid (snapshots/summaries)', () => {
      const messages: ClaudeMessage[] = [
        {
          type: 'file-history-snapshot',
          timestamp: '2026-01-09T12:00:00.000Z',
          sessionId: 'test-session'
        } as any,
        {
          uuid: 'user-1',
          type: 'user',
          timestamp: '2026-01-09T12:00:01.000Z',
          sessionId: 'test-session',
          message: { role: 'user', content: 'hello' }
        },
        {
          type: 'summary',
          timestamp: '2026-01-09T12:00:02.000Z',
          sessionId: 'test-session'
        } as any,
        {
          uuid: 'assistant-1',
          type: 'assistant',
          timestamp: '2026-01-09T12:00:05.000Z',
          sessionId: 'test-session',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi!' }],
            usage: { input_tokens: 10, output_tokens: 5 }
          }
        }
      ];

      const syncState: SyncState = {
        lastSyncedMessageUuid: undefined,
        lastSyncedHistoryIndex: -1
      };

      const result = transformMessages(messages, syncState, ASSISTANT_ID, AGENT_NAME);

      // Should process normally, skipping messages without uuid
      expect(result.history).toHaveLength(2);
      expect(result.lastProcessedMessageUuid).toBe('assistant-1');
    });
  });
});
