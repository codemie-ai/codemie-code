/**
 * History Loader Unit Tests
 *
 * Tests the conversation history loading functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync } from 'fs';

// Mock dependencies before importing the module
vi.mock('fs', () => ({
  existsSync: vi.fn()
}));

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn()
  }
}));

vi.mock('@/agents/core/session/session-config.js', () => ({
  getSessionConversationPath: vi.fn((id: string) => `/mock/sessions/${id}_conversation.jsonl`)
}));

vi.mock('@/providers/plugins/sso/session/utils/jsonl-reader.js', () => ({
  readJSONL: vi.fn()
}));

vi.mock('@/providers/plugins/sso/session/processors/conversations/conversation-types.js', async () => {
  const actual = await vi.importActual('@/providers/plugins/sso/session/processors/conversations/conversation-types.js') as any;
  return {
    ...actual,
    CONVERSATION_SYNC_STATUS: {
      PENDING: 'pending',
      SUCCESS: 'success',
      FAILED: 'failed'
    }
  };
});

describe('loadConversationHistory', () => {
  let loadConversationHistory: any;
  let readJSONL: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Dynamic import to get fresh mocks
    const module = await import('@/cli/commands/assistants/chat/historyLoader.js');
    loadConversationHistory = module.loadConversationHistory;

    const jsonlModule = await import('@/providers/plugins/sso/session/utils/jsonl-reader.js');
    readJSONL = jsonlModule.readJSONL;
  });

  describe('when no conversation ID is provided', () => {
    it('should return empty array', async () => {
      const result = await loadConversationHistory(undefined);
      expect(result).toEqual([]);
    });
  });

  describe('when conversation file does not exist', () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(false);
    });

    it('should return empty array', async () => {
      const result = await loadConversationHistory('test-id');
      expect(result).toEqual([]);
    });

    it('should not attempt to read file', async () => {
      await loadConversationHistory('test-id');
      expect(readJSONL).not.toHaveBeenCalled();
    });
  });

  describe('when conversation file exists', () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(true);
    });

    describe('with no success records', () => {
      beforeEach(() => {
        readJSONL.mockResolvedValue([
          { status: 'pending', payload: { history: [] } },
          { status: 'failed', payload: { history: [] } }
        ]);
      });

      it('should return empty array', async () => {
        const result = await loadConversationHistory('test-id');
        expect(result).toEqual([]);
      });
    });

    describe('with success records but no history', () => {
      beforeEach(() => {
        readJSONL.mockResolvedValue([
          { status: 'success', payload: { history: [] } }
        ]);
      });

      it('should return empty array', async () => {
        const result = await loadConversationHistory('test-id');
        expect(result).toEqual([]);
      });
    });

    describe('with valid success records and history', () => {
      beforeEach(() => {
        readJSONL.mockResolvedValue([
          {
            status: 'success',
            timestamp: 1000,
            payload: {
              conversationId: 'test-id',
              history: [
                { role: 'User', message: 'Hello', history_index: 0 },
                { role: 'Assistant', message: 'Hi there', history_index: 0 }
              ]
            }
          }
        ]);
      });

      it('should return transformed history', async () => {
        const result = await loadConversationHistory('test-id');
        expect(result).toEqual([
          { role: 'User', message: 'Hello', message_raw: 'Hello' },
          { role: 'Assistant', message: 'Hi there', message_raw: 'Hi there' }
        ]);
      });

      it('should only include role, message, and message_raw fields', async () => {
        const result = await loadConversationHistory('test-id');
        result.forEach(msg => {
          expect(Object.keys(msg).sort()).toEqual(['message', 'message_raw', 'role']);
        });
      });
    });

    describe('with multiple success records', () => {
      beforeEach(() => {
        readJSONL.mockResolvedValue([
          {
            status: 'success',
            timestamp: 1000,
            payload: {
              history: [
                { role: 'User', message: 'First', history_index: 0 }
              ]
            }
          },
          {
            status: 'success',
            timestamp: 2000,
            payload: {
              history: [
                { role: 'User', message: 'First', history_index: 0 },
                { role: 'Assistant', message: 'Second', history_index: 0 },
                { role: 'User', message: 'Third', history_index: 1 }
              ]
            }
          }
        ]);
      });

      it('should use the most recent (last) success record', async () => {
        const result = await loadConversationHistory('test-id');
        expect(result).toHaveLength(3);
        expect(result[2].message).toBe('Third');
      });
    });

    describe('error handling', () => {
      beforeEach(() => {
        readJSONL.mockRejectedValue(new Error('Read error'));
      });

      it('should return empty array on error', async () => {
        const result = await loadConversationHistory('test-id');
        expect(result).toEqual([]);
      });

      it('should not throw error', async () => {
        await expect(loadConversationHistory('test-id')).resolves.not.toThrow();
      });
    });
  });
});
