/**
 * Tests for multi-format tool call extraction
 * Validates Anthropic, OpenAI, and Google Gemini format support
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Analytics } from '../index.js';
import type { AnalyticsEvent } from '../types.js';

describe('Analytics - Multi-Format Tool Extraction', () => {
  let analytics: Analytics;
  let trackedEvents: AnalyticsEvent[] = [];

  beforeEach(() => {
    // Create analytics instance with tracking enabled
    analytics = new Analytics({
      enabled: true,
      target: 'local',
      localPath: '/tmp/test-analytics',
      flushInterval: 10000,
      maxBufferSize: 100
    });

    // Start a test session
    analytics.startSession({
      agent: 'test-agent',
      agentVersion: '1.0.0',
      cliVersion: '0.0.11',
      profile: 'test',
      provider: 'test-provider',
      model: 'test-model',
      workingDir: '/tmp',
      interactive: true
    });

    // Intercept tracked events
    trackedEvents = [];
    const originalTrack = analytics.track.bind(analytics);
    analytics.track = async (eventType, attributes, metrics) => {
      trackedEvents.push({
        timestamp: new Date().toISOString(),
        eventType,
        sessionId: 'test-session',
        installationId: 'test-install',
        agent: 'test-agent',
        agentVersion: '1.0.0',
        cliVersion: '0.0.11',
        profile: 'test',
        provider: 'test-provider',
        model: 'test-model',
        attributes: attributes || {},
        metrics
      });
      return originalTrack(eventType, attributes, metrics);
    };
  });

  afterEach(async () => {
    await analytics.destroy();
  });

  describe('Anthropic Format', () => {
    it('should extract tool calls from Anthropic response', async () => {
      const responseBody = {
        content: [
          { type: 'text', text: 'Let me help you with that' },
          {
            type: 'tool_use',
            id: 'toolu_123',
            name: 'Read',
            input: { file_path: '/path/to/file' }
          }
        ]
      };

      await analytics.trackAPIResponse({
        statusCode: 200,
        responseBody,
        latency: 1000
      });

      const toolCallEvents = trackedEvents.filter(e => e.eventType === 'tool_call');
      expect(toolCallEvents).toHaveLength(1);
      expect(toolCallEvents[0].attributes.toolName).toBe('Read');
      expect(toolCallEvents[0].attributes.toolUseId).toBe('toolu_123');
      expect(toolCallEvents[0].attributes.format).toBe('anthropic');
      expect(toolCallEvents[0].attributes.hasInput).toBe(true);
    });

    it('should extract tool results from Anthropic request', async () => {
      const requestBody = {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_123',
            is_error: false,
            content: 'File contents here'
          }
        ]
      };

      await analytics.trackAPIResponse({
        statusCode: 200,
        requestBody,
        latency: 500
      });

      const toolResultEvents = trackedEvents.filter(e => e.eventType === 'tool_result');
      expect(toolResultEvents).toHaveLength(1);
      expect(toolResultEvents[0].attributes.toolUseId).toBe('toolu_123');
      expect(toolResultEvents[0].attributes.success).toBe(true);
      expect(toolResultEvents[0].attributes.isError).toBe(false);
      expect(toolResultEvents[0].attributes.format).toBe('anthropic');
    });

    it('should track tool errors from Anthropic request', async () => {
      const requestBody = {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_456',
            is_error: true,
            content: 'Error: File not found'
          }
        ]
      };

      await analytics.trackAPIResponse({
        statusCode: 200,
        requestBody
      });

      const toolErrorEvents = trackedEvents.filter(e => e.eventType === 'tool_error');
      expect(toolErrorEvents).toHaveLength(1);
      expect(toolErrorEvents[0].attributes.toolUseId).toBe('toolu_456');
      expect(toolErrorEvents[0].attributes.format).toBe('anthropic');
    });
  });

  describe('OpenAI Format', () => {
    it('should extract tool calls from OpenAI response', async () => {
      const responseBody = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_abc123',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: '{"path": "/test/file.txt"}'
                  }
                }
              ]
            }
          }
        ]
      };

      await analytics.trackAPIResponse({
        statusCode: 200,
        responseBody,
        latency: 1200
      });

      const toolCallEvents = trackedEvents.filter(e => e.eventType === 'tool_call');
      expect(toolCallEvents).toHaveLength(1);
      expect(toolCallEvents[0].attributes.toolName).toBe('read_file');
      expect(toolCallEvents[0].attributes.toolUseId).toBe('call_abc123');
      expect(toolCallEvents[0].attributes.format).toBe('openai');
      expect(toolCallEvents[0].attributes.hasArguments).toBe(true);
    });

    it('should extract tool results from OpenAI request', async () => {
      const requestBody = {
        messages: [
          { role: 'user', content: 'Read the file' },
          {
            role: 'tool',
            tool_call_id: 'call_abc123',
            content: 'File contents: Hello World'
          }
        ]
      };

      await analytics.trackAPIResponse({
        statusCode: 200,
        requestBody,
        latency: 600
      });

      const toolResultEvents = trackedEvents.filter(e => e.eventType === 'tool_result');
      expect(toolResultEvents).toHaveLength(1);
      expect(toolResultEvents[0].attributes.toolUseId).toBe('call_abc123');
      expect(toolResultEvents[0].attributes.success).toBe(true);
      expect(toolResultEvents[0].attributes.format).toBe('openai');
    });

    it('should detect errors in OpenAI tool results', async () => {
      const requestBody = {
        messages: [
          {
            role: 'tool',
            tool_call_id: 'call_xyz789',
            content: 'Error: Permission denied'
          }
        ]
      };

      await analytics.trackAPIResponse({
        statusCode: 200,
        requestBody
      });

      const toolErrorEvents = trackedEvents.filter(e => e.eventType === 'tool_error');
      expect(toolErrorEvents).toHaveLength(1);
      expect(toolErrorEvents[0].attributes.toolUseId).toBe('call_xyz789');
      expect(toolErrorEvents[0].attributes.format).toBe('openai');
    });

    it('should handle multiple tool calls in OpenAI response', async () => {
      const responseBody = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{}' }
                },
                {
                  id: 'call_2',
                  type: 'function',
                  function: { name: 'write_file', arguments: '{}' }
                }
              ]
            }
          }
        ]
      };

      await analytics.trackAPIResponse({
        statusCode: 200,
        responseBody
      });

      const toolCallEvents = trackedEvents.filter(e => e.eventType === 'tool_call');
      expect(toolCallEvents).toHaveLength(2);
      expect(toolCallEvents[0].attributes.toolName).toBe('read_file');
      expect(toolCallEvents[1].attributes.toolName).toBe('write_file');
    });
  });

  describe('Google Gemini Format', () => {
    it('should extract tool calls from Gemini response', async () => {
      const responseBody = {
        candidates: [
          {
            content: {
              parts: [
                { text: 'I will help you' },
                {
                  functionCall: {
                    name: 'searchFiles',
                    args: { query: 'test.js', path: '/src' }
                  }
                }
              ]
            }
          }
        ]
      };

      await analytics.trackAPIResponse({
        statusCode: 200,
        responseBody,
        latency: 900
      });

      const toolCallEvents = trackedEvents.filter(e => e.eventType === 'tool_call');
      expect(toolCallEvents).toHaveLength(1);
      expect(toolCallEvents[0].attributes.toolName).toBe('searchFiles');
      expect(toolCallEvents[0].attributes.format).toBe('gemini');
      expect(toolCallEvents[0].attributes.hasArgs).toBe(true);
    });

    it('should extract tool results from Gemini request', async () => {
      const requestBody = {
        contents: [
          {
            parts: [
              {
                functionResponse: {
                  name: 'searchFiles',
                  response: { files: ['test.js', 'test2.js'] }
                }
              }
            ]
          }
        ]
      };

      await analytics.trackAPIResponse({
        statusCode: 200,
        requestBody,
        latency: 400
      });

      const toolResultEvents = trackedEvents.filter(e => e.eventType === 'tool_result');
      expect(toolResultEvents).toHaveLength(1);
      expect(toolResultEvents[0].attributes.toolName).toBe('searchFiles');
      expect(toolResultEvents[0].attributes.success).toBe(true);
      expect(toolResultEvents[0].attributes.format).toBe('gemini');
    });

    it('should detect errors in Gemini tool results', async () => {
      const requestBody = {
        contents: [
          {
            parts: [
              {
                functionResponse: {
                  name: 'searchFiles',
                  response: { error: 'No files found' }
                }
              }
            ]
          }
        ]
      };

      await analytics.trackAPIResponse({
        statusCode: 200,
        requestBody
      });

      const toolErrorEvents = trackedEvents.filter(e => e.eventType === 'tool_error');
      expect(toolErrorEvents).toHaveLength(1);
      expect(toolErrorEvents[0].attributes.toolName).toBe('searchFiles');
      expect(toolErrorEvents[0].attributes.format).toBe('gemini');
    });
  });

  describe('Format Priority and Edge Cases', () => {
    it('should handle empty response body', async () => {
      await analytics.trackAPIResponse({
        statusCode: 200,
        responseBody: {},
        latency: 100
      });

      const toolCallEvents = trackedEvents.filter(e => e.eventType === 'tool_call');
      expect(toolCallEvents).toHaveLength(0);
    });

    it('should handle null/undefined bodies', async () => {
      await analytics.trackAPIResponse({
        statusCode: 200,
        responseBody: null,
        requestBody: undefined,
        latency: 100
      });

      const toolEvents = trackedEvents.filter(
        e => e.eventType === 'tool_call' || e.eventType === 'tool_result'
      );
      expect(toolEvents).toHaveLength(0);
    });

    it('should track api_response event even without tool calls', async () => {
      await analytics.trackAPIResponse({
        statusCode: 200,
        responseBody: { choices: [{ message: { content: 'No tools used' } }] },
        latency: 500
      });

      const apiResponseEvents = trackedEvents.filter(e => e.eventType === 'api_response');
      expect(apiResponseEvents).toHaveLength(1);
      expect(apiResponseEvents[0].metrics?.latencyMs).toBe(500);
    });

    it('should stop processing after finding a format', async () => {
      // Mixed format (should use Anthropic and ignore fake OpenAI)
      const responseBody = {
        content: [{ type: 'tool_use', name: 'Read', id: 'toolu_1' }],
        choices: [{ message: { tool_calls: [{ function: { name: 'FakeTool' } }] } }]
      };

      await analytics.trackAPIResponse({
        statusCode: 200,
        responseBody
      });

      const toolCallEvents = trackedEvents.filter(e => e.eventType === 'tool_call');
      expect(toolCallEvents).toHaveLength(1);
      expect(toolCallEvents[0].attributes.toolName).toBe('Read');
      expect(toolCallEvents[0].attributes.format).toBe('anthropic');
    });
  });
});
