import { describe, it, expect } from 'vitest';
import {
  extractRoutingHeaders,
  injectIntoJsonBody,
  injectIntoSseChunk,
} from '../routing-header-injector.plugin.js';

describe('RoutingHeaderInjectorPlugin', () => {
  describe('extractRoutingHeaders', () => {
    it('captures x-litellm-* headers with hyphens intact', () => {
      const headers = {
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-router-cause': 'llm_classifier',
        'x-litellm-model-name': 'claude-sonnet-5',
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-router-cause': 'llm_classifier',
        'x-litellm-model-name': 'claude-sonnet-5',
      });
    });

    it('captures x-codemie-routing-* and x-codemie-requested-* headers, converting hyphens to underscores', () => {
      const headers = {
        'x-codemie-routing-tier': 'efficient',
        'x-codemie-routing-source': 'judge',
        'x-codemie-requested-model': 'claude-sonnet-4-6',
        'x-codemie-routing-judge-cost-usd': '0.002475',
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({
        'x_codemie_routing_tier': 'efficient',
        'x_codemie_routing_source': 'judge',
        'x_codemie_requested_model': 'claude-sonnet-4-6',
        'x_codemie_routing_judge_cost_usd': '0.002475',
      });
    });

    it('ignores non-routing headers', () => {
      const headers = {
        'authorization': 'Bearer secret-token',
        'content-type': 'application/json',
        'x-custom-header': 'value',
        'x-litellm-router-tier': 'SIMPLE',
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({
        'x-litellm-router-tier': 'SIMPLE',
      });
    });

    it('handles array-valued headers by taking the first element', () => {
      const headers = {
        'x-litellm-router-signals': ['["llm-classifier:COMPLEX"]', 'ignored'],
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({
        'x-litellm-router-signals': '["llm-classifier:COMPLEX"]',
      });
    });

    it('ignores null and undefined values', () => {
      const headers = {
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-missing': null as unknown as string,
        'x-codemie-routing-tier': undefined as unknown as string,
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({
        'x-litellm-router-tier': 'COMPLEX',
      });
    });

    it('returns empty object when no routing headers are present', () => {
      const headers = {
        'authorization': 'Bearer token',
        'content-type': 'application/json',
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({});
    });

    it('case-insensitive matching for header names', () => {
      const headers = {
        'X-LiteLLM-Router-Tier': 'COMPLEX',
        'X-CodeMie-Routing-Tier': 'efficient',
      };
      const result = extractRoutingHeaders(headers);
      expect(result).toEqual({
        'x-litellm-router-tier': 'COMPLEX',
        'x_codemie_routing_tier': 'efficient',
      });
    });
  });

  describe('injectIntoJsonBody', () => {
    it('merges injections into a JSON object', () => {
      const body = Buffer.from(JSON.stringify({ id: 'msg_123', role: 'assistant', content: [] }));
      const injections = {
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-model-name': 'claude-sonnet-5',
      };
      const result = injectIntoJsonBody(body, injections);
      const parsed = JSON.parse(result.toString('utf-8'));
      expect(parsed).toEqual({
        id: 'msg_123',
        role: 'assistant',
        content: [],
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-model-name': 'claude-sonnet-5',
      });
    });

    it('returns original buffer when injections are empty', () => {
      const body = Buffer.from(JSON.stringify({ id: 'msg_123' }));
      const result = injectIntoJsonBody(body, {});
      expect(result).toBe(body);
    });

    it('returns original buffer when body is not a JSON object', () => {
      const testCases = [
        Buffer.from('not json'),
        Buffer.from('[]'),
        Buffer.from('null'),
        Buffer.from('123'),
        Buffer.from('true'),
      ];
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      for (const body of testCases) {
        const result = injectIntoJsonBody(body, injections);
        expect(result).toBe(body);
      }
    });

    it('returns original buffer on parse error', () => {
      const body = Buffer.from('{broken json}');
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoJsonBody(body, injections);
      expect(result).toBe(body);
    });

    it('overwrites existing keys if injections have the same key', () => {
      const body = Buffer.from(JSON.stringify({ id: 'msg_123', 'x-litellm-router-tier': 'old' }));
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoJsonBody(body, injections);
      const parsed = JSON.parse(result.toString('utf-8'));
      expect(parsed['x-litellm-router-tier']).toBe('COMPLEX');
    });
  });

  describe('injectIntoSseChunk', () => {
    it('injects fields into the message object of a message_start event', () => {
      const chunk = Buffer.from(
        'data: ' +
          JSON.stringify({
            type: 'message_start',
            message: { id: 'msg_123', role: 'assistant', model: 'claude-sonnet-5' },
          })
      );
      const injections = {
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-model-name': 'claude-sonnet-5',
      };
      const result = injectIntoSseChunk(chunk, injections);
      const line = result.toString('utf-8');
      const parsed = JSON.parse(line.slice(6));
      expect(parsed.message).toEqual({
        id: 'msg_123',
        role: 'assistant',
        model: 'claude-sonnet-5',
        'x-litellm-router-tier': 'COMPLEX',
        'x-litellm-model-name': 'claude-sonnet-5',
      });
    });

    it('preserves non-message_start events unchanged', () => {
      const chunk = Buffer.from(
        'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta' } })
      );
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoSseChunk(chunk, injections);
      expect(result).toBe(chunk);
    });

    it('preserves non-JSON lines unchanged', () => {
      const chunk = Buffer.from('data: [DONE]');
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoSseChunk(chunk, injections);
      expect(result).toBe(chunk);
    });

    it('preserves other event types in a multi-line chunk', () => {
      const multiLine = `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1' } })}
data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })}
data: [DONE]`;
      const chunk = Buffer.from(multiLine);
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoSseChunk(chunk, injections);
      const lines = result.toString('utf-8').split('\n');
      // First line should be modified, others unchanged
      expect(JSON.parse(lines[0].slice(6)).message['x-litellm-router-tier']).toBe('COMPLEX');
      expect(lines[1]).toBe(
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })}`
      );
      expect(lines[2]).toBe('data: [DONE]');
    });

    it('returns original buffer when injections are empty', () => {
      const chunk = Buffer.from(
        'data: ' + JSON.stringify({ type: 'message_start', message: { id: 'msg_123' } })
      );
      const result = injectIntoSseChunk(chunk, {});
      expect(result).toBe(chunk);
    });

    it('returns original buffer when no message_start is present', () => {
      const chunk = Buffer.from('data: ' + JSON.stringify({ type: 'content_block_delta' }));
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoSseChunk(chunk, injections);
      expect(result).toBe(chunk);
    });

    it('handles partial lines gracefully (does not parse or modify)', () => {
      const chunk = Buffer.from('data: {"type":"message_st');
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoSseChunk(chunk, injections);
      expect(result).toBe(chunk);
    });

    it('injects into all message_start events in a multi-line chunk', () => {
      const multiStart = `data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1' } })}
data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_2' } })}`;
      const chunk = Buffer.from(multiStart);
      const injections = { 'x-litellm-router-tier': 'COMPLEX' };
      const result = injectIntoSseChunk(chunk, injections);
      const lines = result.toString('utf-8').split('\n');
      // Both get injected (both are message_start events)
      expect(JSON.parse(lines[0].slice(6)).message['x-litellm-router-tier']).toBe('COMPLEX');
      expect(JSON.parse(lines[1].slice(6)).message['x-litellm-router-tier']).toBe('COMPLEX');
    });
  });
});
