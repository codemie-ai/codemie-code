import { describe, it, expect } from 'vitest';
import { detectTurns, filterNewMessages, type GeminiMessage } from '../turn-detector.js';

describe('turn-detector', () => {
  describe('detectTurns', () => {
    it('should detect single complete turn (user → gemini)', () => {
      const messages: GeminiMessage[] = [
        {
          id: 'msg-1',
          type: 'user',
          timestamp: '2024-01-16T10:00:00Z',
          content: 'Hello'
        },
        {
          id: 'msg-2',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:01Z',
          content: 'Hi there!'
        }
      ];

      const turns = detectTurns(messages);

      expect(turns).toHaveLength(1);
      expect(turns[0].startIndex).toBe(0);
      expect(turns[0].endIndex).toBe(1);
      expect(turns[0].userMessage.id).toBe('msg-1');
      expect(turns[0].geminiMessages).toHaveLength(1);
      expect(turns[0].geminiMessages[0].id).toBe('msg-2');
      expect(turns[0].systemMessages).toHaveLength(0);
    });

    it('should detect multiple turns', () => {
      const messages: GeminiMessage[] = [
        { id: 'msg-1', type: 'user', timestamp: '2024-01-16T10:00:00Z', content: 'First' },
        { id: 'msg-2', type: 'gemini', timestamp: '2024-01-16T10:00:01Z', content: 'Response 1' },
        { id: 'msg-3', type: 'user', timestamp: '2024-01-16T10:00:02Z', content: 'Second' },
        { id: 'msg-4', type: 'gemini', timestamp: '2024-01-16T10:00:03Z', content: 'Response 2' }
      ];

      const turns = detectTurns(messages);

      expect(turns).toHaveLength(2);

      // First turn
      expect(turns[0].userMessage.id).toBe('msg-1');
      expect(turns[0].geminiMessages[0].id).toBe('msg-2');

      // Second turn
      expect(turns[1].userMessage.id).toBe('msg-3');
      expect(turns[1].geminiMessages[0].id).toBe('msg-4');
    });

    it('should handle multiple gemini messages in single turn', () => {
      const messages: GeminiMessage[] = [
        { id: 'msg-1', type: 'user', timestamp: '2024-01-16T10:00:00Z', content: 'Question' },
        { id: 'msg-2', type: 'gemini', timestamp: '2024-01-16T10:00:01Z', content: 'Part 1' },
        { id: 'msg-3', type: 'gemini', timestamp: '2024-01-16T10:00:02Z', content: 'Part 2' },
        { id: 'msg-4', type: 'gemini', timestamp: '2024-01-16T10:00:03Z', content: 'Part 3' }
      ];

      const turns = detectTurns(messages);

      expect(turns).toHaveLength(1);
      expect(turns[0].geminiMessages).toHaveLength(3);
      expect(turns[0].geminiMessages.map(m => m.id)).toEqual(['msg-2', 'msg-3', 'msg-4']);
    });

    it('should handle system message ending turn', () => {
      const messages: GeminiMessage[] = [
        { id: 'msg-1', type: 'user', timestamp: '2024-01-16T10:00:00Z', content: 'Question' },
        { id: 'msg-2', type: 'gemini', timestamp: '2024-01-16T10:00:01Z', content: 'Answer' },
        { id: 'msg-3', type: 'error', timestamp: '2024-01-16T10:00:02Z', content: 'Connection lost' }
      ];

      const turns = detectTurns(messages);

      expect(turns).toHaveLength(1);
      expect(turns[0].geminiMessages).toHaveLength(1);
      expect(turns[0].systemMessages).toHaveLength(1);
      expect(turns[0].systemMessages[0].type).toBe('error');
    });

    it('should handle incomplete turn (no gemini response)', () => {
      const messages: GeminiMessage[] = [
        { id: 'msg-1', type: 'user', timestamp: '2024-01-16T10:00:00Z', content: 'Question' }
      ];

      const turns = detectTurns(messages);

      expect(turns).toHaveLength(1);
      expect(turns[0].geminiMessages).toHaveLength(0);
    });

    it('should handle empty messages array', () => {
      const turns = detectTurns([]);
      expect(turns).toHaveLength(0);
    });

    it('should handle info and warning system messages', () => {
      const messages: GeminiMessage[] = [
        { id: 'msg-1', type: 'user', timestamp: '2024-01-16T10:00:00Z', content: 'Question' },
        { id: 'msg-2', type: 'info', timestamp: '2024-01-16T10:00:01Z', content: 'Info message' },
        { id: 'msg-3', type: 'user', timestamp: '2024-01-16T10:00:02Z', content: 'Another' },
        { id: 'msg-4', type: 'warning', timestamp: '2024-01-16T10:00:03Z', content: 'Warning' }
      ];

      const turns = detectTurns(messages);

      expect(turns).toHaveLength(2);
      expect(turns[0].systemMessages[0].type).toBe('info');
      expect(turns[1].systemMessages[0].type).toBe('warning');
    });
  });

  describe('filterNewMessages', () => {
    const messages: GeminiMessage[] = [
      { id: 'msg-1', type: 'user', timestamp: '2024-01-16T10:00:00Z', content: 'First' },
      { id: 'msg-2', type: 'gemini', timestamp: '2024-01-16T10:00:01Z', content: 'Response 1' },
      { id: 'msg-3', type: 'user', timestamp: '2024-01-16T10:00:02Z', content: 'Second' },
      { id: 'msg-4', type: 'gemini', timestamp: '2024-01-16T10:00:03Z', content: 'Response 2' }
    ];

    it('should return all messages on first sync (null lastSyncedId)', () => {
      const newMessages = filterNewMessages(messages, null);
      expect(newMessages).toHaveLength(4);
      expect(newMessages).toEqual(messages);
    });

    it('should filter messages after last synced', () => {
      const newMessages = filterNewMessages(messages, 'msg-2');
      expect(newMessages).toHaveLength(2);
      expect(newMessages[0].id).toBe('msg-3');
      expect(newMessages[1].id).toBe('msg-4');
    });

    it('should return all messages if lastSyncedId not found', () => {
      const newMessages = filterNewMessages(messages, 'non-existent');
      expect(newMessages).toHaveLength(4);
      expect(newMessages).toEqual(messages);
    });

    it('should return empty array if last synced is the last message', () => {
      const newMessages = filterNewMessages(messages, 'msg-4');
      expect(newMessages).toHaveLength(0);
    });
  });
});
