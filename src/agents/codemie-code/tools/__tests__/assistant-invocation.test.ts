/**
 * Unit tests for InvokeAssistantTool
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BaseMessage } from '@langchain/core/messages';
import type { CodeMieClient } from 'codemie-sdk';

// Mock dependencies before importing
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: {
    load: vi.fn()
  },
  loadRegisteredAssistants: vi.fn()
}));

vi.mock('@/utils/auth.js', () => ({
  getAuthenticatedClient: vi.fn()
}));

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    getSessionId: vi.fn(() => 'test-session-123')
  }
}));

// Import after mocks
const {
  findAssistantBySlug,
  convertConversationHistory,
  invokeAssistantViaSdk,
  InvokeAssistantTool
} = await import('../assistant-invocation.js');

const { ConfigLoader, loadRegisteredAssistants } = await import('@/utils/config.js');
const { getAuthenticatedClient } = await import('@/utils/auth.js');

describe('Assistant Invocation Tool', () => {
  const mockAssistants = [
    {
      id: 'assistant-1',
      slug: 'solution-architect',
      name: 'Solution Architect',
      description: 'Architecture expert'
    },
    {
      id: 'assistant-2',
      slug: 'code-reviewer',
      name: 'Code Reviewer',
      description: 'Code review expert'
    }
  ];

  const mockConfig = {
    codemieAssistants: mockAssistants
  };

  const mockClient = {
    assistants: {
      chat: vi.fn()
    }
  } as unknown as CodeMieClient;

  beforeEach(() => {
    vi.clearAllMocks();
    (ConfigLoader.load as any).mockResolvedValue(mockConfig);
    (loadRegisteredAssistants as any).mockResolvedValue(mockAssistants);
    (getAuthenticatedClient as any).mockResolvedValue(mockClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadRegisteredAssistants', () => {
    it('should load assistants from config', async () => {
      const result = await loadRegisteredAssistants();

      expect(result).toEqual(mockAssistants);
      expect(loadRegisteredAssistants).toHaveBeenCalled();
    });

    it('should return empty array on config load failure', async () => {
      (loadRegisteredAssistants as any).mockResolvedValueOnce([]);

      const result = await loadRegisteredAssistants();

      expect(result).toEqual([]);
    });

    it('should return empty array if no assistants configured', async () => {
      (loadRegisteredAssistants as any).mockResolvedValueOnce([]);

      const result = await loadRegisteredAssistants();

      expect(result).toEqual([]);
    });
  });

  describe('findAssistantBySlug', () => {
    it('should find assistant by slug', () => {
      const result = findAssistantBySlug(mockAssistants, 'solution-architect');

      expect(result).toEqual(mockAssistants[0]);
    });

    it('should return undefined for non-existent slug', () => {
      const result = findAssistantBySlug(mockAssistants, 'non-existent');

      expect(result).toBeUndefined();
    });

    it('should handle empty assistants array', () => {
      const result = findAssistantBySlug([], 'any-slug');

      expect(result).toBeUndefined();
    });
  });

  describe('convertConversationHistory', () => {
    it('should convert human messages to User role', () => {
      const messages: BaseMessage[] = [
        { _getType: () => 'human', content: 'Hello' } as any
      ];

      const result = convertConversationHistory(messages);

      expect(result).toEqual([
        { role: 'User', message: 'Hello' }
      ]);
    });

    it('should convert AI messages to Assistant role', () => {
      const messages: BaseMessage[] = [
        { _getType: () => 'ai', content: 'Hi there' } as any
      ];

      const result = convertConversationHistory(messages);

      expect(result).toEqual([
        { role: 'Assistant', message: 'Hi there' }
      ]);
    });

    it('should filter out non-human/ai messages', () => {
      const messages: BaseMessage[] = [
        { _getType: () => 'human', content: 'Hello' } as any,
        { _getType: () => 'system', content: 'System message' } as any,
        { _getType: () => 'ai', content: 'Hi there' } as any
      ];

      const result = convertConversationHistory(messages);

      expect(result).toEqual([
        { role: 'User', message: 'Hello' },
        { role: 'Assistant', message: 'Hi there' }
      ]);
    });

    it('should handle object content by stringifying', () => {
      const messages: BaseMessage[] = [
        { _getType: () => 'human', content: { text: 'Hello', meta: 'data' } } as any
      ];

      const result = convertConversationHistory(messages);

      expect(result).toEqual([
        { role: 'User', message: '{"text":"Hello","meta":"data"}' }
      ]);
    });

    it('should handle empty history', () => {
      const result = convertConversationHistory([]);

      expect(result).toEqual([]);
    });
  });

  describe('invokeAssistantViaSdk', () => {
    it('should invoke assistant and return string response', async () => {
      (mockClient.assistants.chat as any).mockResolvedValueOnce({
        generated: 'Assistant response'
      });

      const result = await invokeAssistantViaSdk(
        mockClient,
        'assistant-1',
        'Test message'
      );

      expect(result).toBe('Assistant response');
      expect(mockClient.assistants.chat).toHaveBeenCalledWith('assistant-1', {
        conversation_id: 'test-session-123',
        text: 'Test message',
        stream: false,
        history: []
      });
    });

    it('should invoke assistant with history', async () => {
      const history = [
        { role: 'User' as const, message: 'Previous message' }
      ];

      (mockClient.assistants.chat as any).mockResolvedValueOnce({
        generated: 'Response with context'
      });

      const result = await invokeAssistantViaSdk(
        mockClient,
        'assistant-1',
        'Follow-up message',
        history
      );

      expect(result).toBe('Response with context');
      expect(mockClient.assistants.chat).toHaveBeenCalledWith('assistant-1', {
        conversation_id: 'test-session-123',
        text: 'Follow-up message',
        history: history,
        stream: false
      });
    });

    it('should pass session ID as conversation_id', async () => {
      (mockClient.assistants.chat as any).mockResolvedValueOnce({
        generated: 'Response'
      });

      await invokeAssistantViaSdk(
        mockClient,
        'assistant-1',
        'Test message'
      );

      expect(mockClient.assistants.chat).toHaveBeenCalledWith('assistant-1',
        expect.objectContaining({
          conversation_id: 'test-session-123'
        })
      );
    });

    it('should handle object response by stringifying', async () => {
      (mockClient.assistants.chat as any).mockResolvedValueOnce({
        generated: { type: 'structured', data: 'value' }
      });

      const result = await invokeAssistantViaSdk(
        mockClient,
        'assistant-1',
        'Test message'
      );

      expect(result).toBe('{"type":"structured","data":"value"}');
    });

    it('should handle missing generated field', async () => {
      (mockClient.assistants.chat as any).mockResolvedValueOnce({
        generated: null
      });

      const result = await invokeAssistantViaSdk(
        mockClient,
        'assistant-1',
        'Test message'
      );

      expect(result).toBe('No response from assistant');
    });

    it('should throw error on SDK failure', async () => {
      (mockClient.assistants.chat as any).mockRejectedValueOnce(
        new Error('Network error')
      );

      await expect(
        invokeAssistantViaSdk(mockClient, 'assistant-1', 'Test message')
      ).rejects.toThrow('Network error');
    });
  });

  describe('InvokeAssistantTool', () => {
    let tool: InstanceType<typeof InvokeAssistantTool>;
    let mockGetHistory: () => BaseMessage[];

    beforeEach(() => {
      mockGetHistory = vi.fn(() => []);
      tool = new InvokeAssistantTool(mockGetHistory);
    });

    it('should have correct name and description', () => {
      expect(tool.name).toBe('invoke_assistant');
      expect(tool.description).toContain('Invoke a registered CodeMie assistant');
    });

    it('should successfully invoke an assistant', async () => {
      (mockClient.assistants.chat as any).mockResolvedValueOnce({
        generated: 'Architecture recommendation'
      });

      const result = await tool._call({
        assistantSlug: 'solution-architect',
        message: 'How should I structure my app?',
        includeHistory: false
      });

      expect(result).toContain('[Assistant @solution-architect]');
      expect(result).toContain('Architecture recommendation');
    });

    it('should include history when requested', async () => {
      const mockHistory: BaseMessage[] = [
        { _getType: () => 'human', content: 'Previous question' } as any,
        { _getType: () => 'ai', content: 'Previous answer' } as any
      ];

      mockGetHistory = vi.fn(() => mockHistory);
      tool = new InvokeAssistantTool(mockGetHistory);

      (mockClient.assistants.chat as any).mockResolvedValueOnce({
        generated: 'Contextual response'
      });

      await tool._call({
        assistantSlug: 'solution-architect',
        message: 'Follow-up question',
        includeHistory: true
      });

      expect(mockGetHistory).toHaveBeenCalled();
      expect(mockClient.assistants.chat).toHaveBeenCalledWith(
        'assistant-1',
        expect.objectContaining({
          history: expect.arrayContaining([
            { role: 'User', message: 'Previous question' },
            { role: 'Assistant', message: 'Previous answer' }
          ])
        })
      );
    });

    it('should return error message if no assistants registered', async () => {
      (loadRegisteredAssistants as any).mockResolvedValueOnce([]);

      const result = await tool._call({
        assistantSlug: 'solution-architect',
        message: 'Test',
        includeHistory: false
      });

      expect(result).toContain('No assistants are currently registered');
    });

    it('should return error message if assistant not found', async () => {
      const result = await tool._call({
        assistantSlug: 'non-existent-assistant',
        message: 'Test',
        includeHistory: false
      });

      expect(result).toContain('Assistant "non-existent-assistant" not found');
      expect(result).toContain('Available assistants:');
      expect(result).toContain('solution-architect');
      expect(result).toContain('code-reviewer');
    });

    it('should handle authentication errors', async () => {
      (getAuthenticatedClient as any).mockRejectedValueOnce(
        new Error('401 Unauthorized')
      );

      const result = await tool._call({
        assistantSlug: 'solution-architect',
        message: 'Test',
        includeHistory: false
      });

      expect(result).toContain('Authentication failed');
      expect(result).toContain('codemie setup');
    });

    it('should handle SDK invocation errors', async () => {
      (mockClient.assistants.chat as any).mockRejectedValueOnce(
        new Error('Service unavailable')
      );

      const result = await tool._call({
        assistantSlug: 'solution-architect',
        message: 'Test',
        includeHistory: false
      });

      expect(result).toContain('Failed to invoke assistant');
      expect(result).toContain('Service unavailable');
    });

    it('should default includeHistory to false', async () => {
      (mockClient.assistants.chat as any).mockResolvedValueOnce({
        generated: 'Response'
      });

      await tool._call({
        assistantSlug: 'solution-architect',
        message: 'Test'
      } as any);

      expect(mockGetHistory).not.toHaveBeenCalled();
    });
  });

  describe('Integration scenarios', () => {
    it('should handle complete flow from invocation to response', async () => {
      const mockHistory: BaseMessage[] = [
        { _getType: () => 'human', content: 'What is clean architecture?' } as any,
        { _getType: () => 'ai', content: 'Clean architecture is...' } as any
      ];

      const mockGetHistory = vi.fn(() => mockHistory);
      const tool = new InvokeAssistantTool(mockGetHistory);

      (mockClient.assistants.chat as any).mockResolvedValueOnce({
        generated: 'Based on our previous discussion about clean architecture...'
      });

      const result = await tool._call({
        assistantSlug: 'solution-architect',
        message: 'How do I apply it to my React app?',
        includeHistory: true
      });

      expect(mockGetHistory).toHaveBeenCalled();
      expect(result).toContain('[Assistant @solution-architect]');
      expect(result).toContain('Based on our previous discussion');
    });

    it('should handle multiple assistants correctly', async () => {
      const tool = new InvokeAssistantTool(() => []);

      (mockClient.assistants.chat as any).mockResolvedValueOnce({
        generated: 'Architecture advice'
      });

      const result1 = await tool._call({
        assistantSlug: 'solution-architect',
        message: 'Help with architecture',
        includeHistory: false
      });

      expect(result1).toContain('[Assistant @solution-architect]');

      (mockClient.assistants.chat as any).mockResolvedValueOnce({
        generated: 'Code review feedback'
      });

      const result2 = await tool._call({
        assistantSlug: 'code-reviewer',
        message: 'Review my code',
        includeHistory: false
      });

      expect(result2).toContain('[Assistant @code-reviewer]');
    });
  });
});
