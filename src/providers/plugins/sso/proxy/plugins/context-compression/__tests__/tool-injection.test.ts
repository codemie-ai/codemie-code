import { describe, it, expect } from 'vitest';
import {
  CCR_TOOL_NAME,
  createCcrToolDefinition,
  createSystemInstructions,
  parseToolCall,
  injectCcrTool,
} from '../ccr/tool_injection.js';

describe('CCR_TOOL_NAME', () => {
  it('is "headroom_retrieve"', () => {
    expect(CCR_TOOL_NAME).toBe('headroom_retrieve');
  });
});

describe('createCcrToolDefinition', () => {
  it('produces anthropic format with name at top level', () => {
    const def = createCcrToolDefinition('anthropic');
    expect(def.name).toBe(CCR_TOOL_NAME);
    expect(def.input_schema).toBeDefined();
    expect(def.input_schema.properties.hash).toBeDefined();
    expect(def.input_schema.required).toContain('hash');
    expect(def.input_schema.properties.query).toBeDefined();
  });

  it('produces openai format with function wrapper', () => {
    const def = createCcrToolDefinition('openai');
    expect(def.type).toBe('function');
    expect(def.function.name).toBe(CCR_TOOL_NAME);
    expect(def.function.parameters.properties.hash).toBeDefined();
  });

  it('defaults to anthropic format', () => {
    const def = createCcrToolDefinition();
    expect(def.name).toBe(CCR_TOOL_NAME);
  });
});

describe('createSystemInstructions', () => {
  it('includes the tool name in the instructions', () => {
    const instructions = createSystemInstructions();
    expect(instructions).toContain(CCR_TOOL_NAME);
  });

  it('mentions [COMPRESSED id=', () => {
    const instructions = createSystemInstructions();
    expect(instructions).toContain('[COMPRESSED id=');
  });
});

describe('parseToolCall', () => {
  const anthropicResponse = {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01abc',
        name: 'headroom_retrieve',
        input: { hash: 'abc123', query: 'errors' },
      },
    ],
  };

  it('detects CCR tool call in anthropic response', () => {
    const calls = parseToolCall(anthropicResponse, 'anthropic');
    expect(calls).toHaveLength(1);
    expect(calls[0].toolCallId).toBe('toolu_01abc');
    expect(calls[0].hashKey).toBe('abc123');
    expect(calls[0].query).toBe('errors');
  });

  it('returns empty array when no CCR calls present', () => {
    const response = { content: [{ type: 'text', text: 'hello' }] };
    const calls = parseToolCall(response, 'anthropic');
    expect(calls).toHaveLength(0);
  });

  it('detects CCR tool call in openai response', () => {
    const openaiResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: {
                  name: 'headroom_retrieve',
                  arguments: JSON.stringify({ hash: 'def456' }),
                },
              },
            ],
          },
        },
      ],
    };
    const calls = parseToolCall(openaiResponse, 'openai');
    expect(calls).toHaveLength(1);
    expect(calls[0].hashKey).toBe('def456');
  });
});

describe('injectCcrTool', () => {
  it('adds CCR tool to anthropic tools array', () => {
    const body = { model: 'claude-3-opus', tools: [] };
    const injected = injectCcrTool(body, 'anthropic');
    expect(injected.tools).toHaveLength(1);
    expect((injected.tools as Array<{ name: string }>)[0].name).toBe(CCR_TOOL_NAME);
  });

  it('creates tools array if missing', () => {
    const body = { model: 'claude-3-opus' };
    const injected = injectCcrTool(body, 'anthropic');
    expect(Array.isArray(injected.tools)).toBe(true);
  });

  it('does not add duplicate if already present', () => {
    const body = {
      model: 'claude-3-opus',
      tools: [{ name: CCR_TOOL_NAME, input_schema: {} }],
    };
    const injected = injectCcrTool(body, 'anthropic');
    expect((injected.tools as unknown[]).length).toBe(1);
  });

  it('appends CCR system instructions when system exists', () => {
    const body = { model: 'claude-3-opus', system: 'You are helpful.' };
    const injected = injectCcrTool(body, 'anthropic');
    expect(injected.system as string).toContain(CCR_TOOL_NAME);
    expect(injected.system as string).toContain('You are helpful.');
  });
});
