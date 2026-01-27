import { describe, it, expect } from 'vitest';
import { extractToolThoughts } from '../tool-aggregator.js';
import type { GeminiMessage } from '../turn-detector.js';

describe('tool-aggregator', () => {
  describe('extractToolThoughts', () => {
    it('should extract tool thoughts from single tool call', () => {
      const messages: GeminiMessage[] = [
        {
          id: 'msg-1',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:00Z',
          content: 'Using tool',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'Read',
              args: { file_path: '/path/to/file.ts' },
              result: [
                {
                  functionResponse: {
                    response: {
                      output: 'File contents here'
                    }
                  }
                }
              ],
              status: 'success',
              timestamp: '2024-01-16T10:00:01Z',
              displayName: 'Read File'
            }
          ]
        }
      ];

      const thoughts = extractToolThoughts(messages);

      expect(thoughts).toHaveLength(1);
      expect(thoughts[0]).toEqual({
        id: 'tool-1',
        metadata: {
          timestamp: '2024-01-16T10:00:01Z',
          displayName: 'Read File'
        },
        in_progress: false,
        input_text: JSON.stringify({ file_path: '/path/to/file.ts' }),
        message: 'File contents here',
        author_type: 'Tool',
        author_name: 'Read',
        output_format: 'text',
        error: false,
        children: []
      });
    });

    it('should extract multiple tool calls from single message', () => {
      const messages: GeminiMessage[] = [
        {
          id: 'msg-1',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:00Z',
          content: 'Using multiple tools',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'Read',
              args: { file_path: '/file1.ts' },
              result: [{ functionResponse: { response: { output: 'Content 1' } } }],
              status: 'success',
              timestamp: '2024-01-16T10:00:01Z'
            },
            {
              id: 'tool-2',
              name: 'Grep',
              args: { pattern: 'test' },
              result: [{ functionResponse: { response: { output: 'Match found' } } }],
              status: 'success',
              timestamp: '2024-01-16T10:00:02Z'
            }
          ]
        }
      ];

      const thoughts = extractToolThoughts(messages);

      expect(thoughts).toHaveLength(2);
      expect(thoughts[0].author_name).toBe('Read');
      expect(thoughts[1].author_name).toBe('Grep');
    });

    it('should extract tool calls across multiple messages', () => {
      const messages: GeminiMessage[] = [
        {
          id: 'msg-1',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:00Z',
          content: 'First tool',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'Read',
              args: { file_path: '/file1.ts' },
              result: [{ functionResponse: { response: { output: 'Content 1' } } }],
              status: 'success',
              timestamp: '2024-01-16T10:00:01Z'
            }
          ]
        },
        {
          id: 'msg-2',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:02Z',
          content: 'Second tool',
          toolCalls: [
            {
              id: 'tool-2',
              name: 'Write',
              args: { file_path: '/file2.ts' },
              result: [{ functionResponse: { response: { output: 'Written successfully' } } }],
              status: 'success',
              timestamp: '2024-01-16T10:00:03Z'
            }
          ]
        }
      ];

      const thoughts = extractToolThoughts(messages);

      expect(thoughts).toHaveLength(2);
    });

    it('should handle tool call with error status', () => {
      const messages: GeminiMessage[] = [
        {
          id: 'msg-1',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:00Z',
          content: 'Tool failed',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'Read',
              args: { file_path: '/nonexistent.ts' },
              result: [{ functionResponse: { response: { output: 'File not found' } } }],
              status: 'error',
              timestamp: '2024-01-16T10:00:01Z'
            }
          ]
        }
      ];

      const thoughts = extractToolThoughts(messages);

      expect(thoughts).toHaveLength(1);
      expect(thoughts[0].error).toBe(true);
    });

    it('should handle object output from tool result', () => {
      const messages: GeminiMessage[] = [
        {
          id: 'msg-1',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:00Z',
          content: 'Using tool',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'Bash',
              args: { command: 'ls' },
              result: [
                {
                  functionResponse: {
                    response: {
                      output: { files: ['file1.ts', 'file2.ts'], count: 2 }
                    }
                  }
                }
              ],
              status: 'success',
              timestamp: '2024-01-16T10:00:01Z'
            }
          ]
        }
      ];

      const thoughts = extractToolThoughts(messages);

      expect(thoughts).toHaveLength(1);
      expect(thoughts[0].message).toBe(JSON.stringify({ files: ['file1.ts', 'file2.ts'], count: 2 }, null, 2));
    });

    it('should handle missing tool result', () => {
      const messages: GeminiMessage[] = [
        {
          id: 'msg-1',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:00Z',
          content: 'Tool in progress',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'Read',
              args: { file_path: '/file.ts' },
              // No result field
              status: 'success',
              timestamp: '2024-01-16T10:00:01Z'
            }
          ]
        }
      ];

      const thoughts = extractToolThoughts(messages);

      expect(thoughts).toHaveLength(1);
      expect(thoughts[0].message).toBe('');
    });

    it('should handle messages without tool calls', () => {
      const messages: GeminiMessage[] = [
        {
          id: 'msg-1',
          type: 'gemini',
          timestamp: '2024-01-16T10:00:00Z',
          content: 'Just a response'
          // No toolCalls
        }
      ];

      const thoughts = extractToolThoughts(messages);

      expect(thoughts).toHaveLength(0);
    });

    it('should handle empty messages array', () => {
      const thoughts = extractToolThoughts([]);
      expect(thoughts).toHaveLength(0);
    });
  });
});
