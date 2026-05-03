import { describe, it, expect, vi } from 'vitest';
import { CCRResponseHandler } from '../ccr/response_handler.js';
import { createCompressionStore } from '../ccr/store.js';

function makeAnthropicResponse(withCcrToolCall: boolean, hash = 'testhash') {
  if (!withCcrToolCall) {
    return { content: [{ type: 'text', text: 'Here is my answer.' }], stop_reason: 'end_turn' };
  }
  return {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01abc',
        name: 'headroom_retrieve',
        input: { hash },
      },
    ],
    stop_reason: 'tool_use',
  };
}

describe('CCRResponseHandler', () => {
  it('returns response unchanged when no CCR tool calls', async () => {
    const store = createCompressionStore();
    const handler = new CCRResponseHandler(undefined, store);
    const response = makeAnthropicResponse(false);

    const result = await handler.handleResponse(
      response,
      [],
      [],
      async () => makeAnthropicResponse(false),
      'anthropic',
    );

    expect(result).toEqual(response);
  });

  it('retrieves content and returns final response after one round', async () => {
    const store = createCompressionStore();
    const hash = store.store('original full content line 1\nline 2\nline 3', 'compressed', {});

    const ccrResponse = makeAnthropicResponse(true, hash);
    const finalResponse = { content: [{ type: 'text', text: 'Got it.' }], stop_reason: 'end_turn' };
    const apiCall = vi.fn().mockResolvedValue(finalResponse);

    const handler = new CCRResponseHandler(undefined, store);
    const result = await handler.handleResponse(
      ccrResponse, [], [], apiCall, 'anthropic',
    );

    expect(result).toEqual(finalResponse);
    expect(apiCall).toHaveBeenCalledTimes(1);

    // Verify the tool_result message shape passed to apiCallFn
    const calledMessages = apiCall.mock.calls[0][0] as Array<Record<string, unknown>>;
    const userTurn = calledMessages.find((m) => m['role'] === 'user');
    expect(userTurn).toBeDefined();
    const toolResults = userTurn!['content'] as Array<Record<string, unknown>>;
    expect(toolResults[0]['type']).toBe('tool_result');
    expect(toolResults[0]['tool_use_id']).toBe('toolu_01abc');
    expect(typeof toolResults[0]['content']).toBe('string');
    expect(toolResults[0]['content'] as string).toContain('original full content');
  });

  it('returns error result when hash not found in store', async () => {
    const store = createCompressionStore();
    const ccrResponse = makeAnthropicResponse(true, 'nonexistent_hash');

    const finalResponse = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
    const apiCall = vi.fn().mockResolvedValue(finalResponse);
    const handler = new CCRResponseHandler(undefined, store);
    await handler.handleResponse(ccrResponse, [], [], apiCall, 'anthropic');
    // apiCall should still be called with "not found" result — no throw
    expect(apiCall).toHaveBeenCalledTimes(1);
    const callArgs = apiCall.mock.calls[0][0];
    expect(JSON.stringify(callArgs)).toContain('not found');
  });

  it('respects max_retrieval_rounds to prevent infinite loop', async () => {
    const store = createCompressionStore();
    const hash = store.store('content', 'compressed', {});

    // API always returns a CCR tool call
    const ccrResponse = makeAnthropicResponse(true, hash);
    const apiCall = vi.fn().mockResolvedValue(ccrResponse);

    const config: ResponseHandlerConfig = { enabled: true, maxRetrievalRounds: 2, stripCcrFromResponse: false, continuationTimeoutMs: 5000 };
    const handler = new CCRResponseHandler(config, store);
    const result = await handler.handleResponse(ccrResponse, [], [], apiCall, 'anthropic');
    expect(apiCall).toHaveBeenCalledTimes(2);
    expect(result).toBeDefined();
  });
});
