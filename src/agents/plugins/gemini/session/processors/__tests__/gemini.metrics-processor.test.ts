import { describe, it, expect, vi } from 'vitest';
import { GeminiMetricsProcessor } from '../gemini.metrics-processor.js';
import type { ParsedSession } from '../../../../../core/session/BaseSessionAdapter.js';
import type { ProcessingContext } from '../../../../../core/session/BaseProcessor.js';

// Mock MetricsWriter to avoid actual file system writes during unit testing
const mockAppendDelta = vi.fn();
vi.mock('../../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js', () => {
  return {
    MetricsWriter: class {
      constructor(public sessionId: string) {}
      appendDelta = mockAppendDelta;
    }
  };
});

describe('GeminiMetricsProcessor', () => {
  it('extracts correct MetricDeltas from Gemini message formats', async () => {
    const processor = new GeminiMetricsProcessor();

    const session: ParsedSession = {
      sessionId: 'sess-abc',
      agentName: 'gemini',
      messages: [
        {
          id: 'user-turn',
          timestamp: '2026-09-03T12:00:00.000Z',
          type: 'user',
          content: '<session_context>some system context OS information</session_context>How to edit a file?'
        },
        {
          id: 'assistant-turn',
          timestamp: '2026-09-03T12:00:01.000Z',
          type: 'gemini',
          model: 'gemini-3-7-flash',
          content: 'Sure! I will use the replace tool.',
          tokens: {
            input: 100,
            output: 50,
            cached: 20,
            thoughts: 10,
            tool: 5,
            total: 185
          },
          toolCalls: [
            {
              id: 'call-1',
              name: 'mcp_serena_replace_content',
              args: {
                relative_path: 'src/file.ts',
                needle: 'old content',
                repl: 'new content\nwith more lines'
              },
              status: 'success',
              timestamp: '2026-09-03T12:00:01.000Z'
            }
          ]
        }
      ],
      metrics: {
        tools: {},
        toolStatus: {},
        fileOperations: []
      }
    };

    const context: ProcessingContext = {
      gitBranch: 'feature-metrics-fix',
    } as any;

    mockAppendDelta.mockClear();

    const result = await processor.process(session, context);
    expect(result.success).toBe(true);

    // Verify written delta details
    expect(mockAppendDelta).toHaveBeenCalledTimes(1);
    const delta = mockAppendDelta.mock.calls[0][0];

    expect(delta.recordId).toBe('assistant-turn');
    expect(delta.sessionId).toBe('sess-abc');
    expect(delta.gitBranch).toBe('feature-metrics-fix');
    expect(delta.models).toEqual(['gemini-3-7-flash']);

    // Verify tool count and status
    expect(delta.tools).toEqual({
      mcp_serena_replace_content: 1
    });
    expect(delta.toolStatus).toEqual({
      mcp_serena_replace_content: { success: 1, failure: 0 }
    });

    // Verify Serena MCP tool mapping and line count calculation
    expect(delta.fileOperations).toHaveLength(1);
    expect(delta.fileOperations[0]).toEqual({
      type: 'edit',
      path: 'src/file.ts',
      format: 'ts',
      language: 'typescript',
      linesAdded: 2,
      linesRemoved: 1
    });

    // Verify user prompt text was correctly extracted and filtered
    expect(delta.userPrompts).toHaveLength(1);
    expect(delta.userPrompts[0]).toEqual({
      count: 1,
      text: 'How to edit a file?'
    });
  });

  it('skips empty user prompts or prompts that only had session context', async () => {
    const processor = new GeminiMetricsProcessor();

    const session: ParsedSession = {
      sessionId: 'sess-context-only',
      agentName: 'gemini',
      messages: [
        {
          id: 'user-turn',
          timestamp: '2026-09-03T12:00:00.000Z',
          type: 'user',
          content: '<session_context>only context</session_context>'
        },
        {
          id: 'assistant-turn',
          timestamp: '2026-09-03T12:00:01.000Z',
          type: 'gemini',
          content: 'Response to context'
        }
      ],
      metrics: { tools: {}, toolStatus: {}, fileOperations: [] }
    };

    mockAppendDelta.mockClear();
    await processor.process(session, {} as any);

    expect(mockAppendDelta).toHaveBeenCalledTimes(1);
    const delta = mockAppendDelta.mock.calls[0][0];
    expect(delta.userPrompts).toBeUndefined();
  });
});
