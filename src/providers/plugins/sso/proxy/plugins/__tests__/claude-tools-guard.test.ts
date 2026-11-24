/**
 * Tools Guard helper tests
 *
 * Source wins over spec: an Anthropic block anywhere beats OpenAI markers, `messages` shapes beat `input`,
 * and a record `tool_choice` whose type is not auto/none is forcing (including `{}`).
 *
 * @group unit
 */

import { describe, it, expect } from 'vitest';
import { applyToolsGuard } from '../claude-tools-guard.js';

const PLACEHOLDER = 'noop_placeholder_tool';

const anthropicBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  messages: [{ role: 'user', content: [{ type: 'tool_use' }] }],
  ...extra,
});

describe('applyToolsGuard', () => {
  describe('no injection', () => {
    it('returns null and leaves the body untouched when tools is non-empty', () => {
      const body = anthropicBody({ tools: [{ name: 'real' }] });
      const clone = structuredClone(body);
      expect(applyToolsGuard(body)).toBeNull();
      expect(body).toEqual(clone);
    });

    it('returns null and adds no tools when there is no tool history', () => {
      const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }] };
      expect(applyToolsGuard(body)).toBeNull();
      expect(body).not.toHaveProperty('tools');
    });

    it('returns null when no messages or input exist', () => {
      const body: Record<string, unknown> = { model: 'x' };
      expect(applyToolsGuard(body)).toBeNull();
      expect(body).not.toHaveProperty('tools');
    });
  });

  describe('shape detection and placeholder wire shape', () => {
    it.each([
      ['tool_use block', { messages: [{ role: 'assistant', content: [{ type: 'tool_use' }] }] }, 'anthropic'],
      ['tool_result block', { messages: [{ role: 'user', content: [{ type: 'tool_result' }] }] }, 'anthropic'],
      ['role tool', { messages: [{ role: 'tool', content: 'x' }] }, 'openai'],
      ['non-empty tool_calls', { messages: [{ role: 'assistant', tool_calls: [{ id: '1' }] }] }, 'openai'],
      ['function_call input', { input: [{ type: 'function_call' }] }, 'responses'],
      ['function_call_output input', { input: [{ type: 'function_call_output' }] }, 'responses'],
    ])('detects %s', (_label, body, expected) => {
      const b = body as Record<string, unknown>;
      expect(applyToolsGuard(b)).toBe(expected);
      const tools = b.tools as Record<string, any>[];
      expect(tools).toHaveLength(1);
      if (expected === 'anthropic') {
        expect(tools[0].name).toBe(PLACEHOLDER);
        expect(tools[0].input_schema).toEqual({ type: 'object', properties: {} });
        expect(tools[0]).not.toHaveProperty('type');
      } else if (expected === 'openai') {
        expect(tools[0].type).toBe('function');
        expect(tools[0].function.name).toBe(PLACEHOLDER);
        expect(tools[0].function.parameters).toEqual({ type: 'object', properties: {} });
      } else {
        expect(tools[0].type).toBe('function');
        expect(tools[0].name).toBe(PLACEHOLDER);
        expect(tools[0].parameters).toEqual({ type: 'object', properties: {} });
      }
    });
  });

  describe('edge cases', () => {
    it('anthropic wins when an openai message precedes it', () => {
      const body = {
        messages: [
          { role: 'tool', content: 'x' },
          { role: 'user', content: [{ type: 'tool_result' }] },
        ],
      };
      expect(applyToolsGuard(body)).toBe('anthropic');
    });

    it('messages history wins over input history', () => {
      const body = { messages: [{ role: 'tool' }], input: [{ type: 'function_call' }] };
      expect(applyToolsGuard(body)).toBe('openai');
    });

    it('replaces an empty tools array', () => {
      const body = anthropicBody({ tools: [] });
      expect(applyToolsGuard(body)).toBe('anthropic');
      expect((body.tools as any[])[0].name).toBe(PLACEHOLDER);
    });

    it.each([[{}], ['x']])('treats non-array tools %j as absent', (tools) => {
      const body = anthropicBody({ tools });
      expect(applyToolsGuard(body)).toBe('anthropic');
      expect(Array.isArray(body.tools)).toBe(true);
    });

    it('does not treat empty tool_calls alone as history', () => {
      expect(applyToolsGuard({ messages: [{ role: 'assistant', tool_calls: [] }] })).toBeNull();
    });

    it.each([
      ['null message', { messages: [null, 42, 's'] }],
      ['malformed content', { messages: [{ content: [null, 42, 's'] }] }],
      ['malformed input', { input: [null, 42, 's'] }],
      ['non-array messages', { messages: 'x' }],
      ['non-array input', { input: { type: 'function_call' } }],
    ])('does not throw and returns null for %s', (_label, body) => {
      expect(applyToolsGuard(body as Record<string, unknown>)).toBeNull();
    });
  });

  describe('tool_choice', () => {
    it.each([
      ['required'],
      ['any'],
      [{}],
      [{ type: 'any' }],
      [{ type: 'tool', name: 'x' }],
      [{ type: 'function', function: { name: 'x' } }],
    ])('deletes forcing tool_choice %j', (toolChoice) => {
      const body = anthropicBody({ tool_choice: toolChoice });
      applyToolsGuard(body);
      expect(body).not.toHaveProperty('tool_choice');
    });

    it.each([['auto'], ['none'], [{ type: 'auto' }], [{ type: 'none' }]])('keeps tool_choice %j', (toolChoice) => {
      const body = anthropicBody({ tool_choice: toolChoice });
      applyToolsGuard(body);
      expect(body.tool_choice).toEqual(toolChoice);
    });

    it('does not add tool_choice when absent', () => {
      const body = anthropicBody();
      applyToolsGuard(body);
      expect(body).not.toHaveProperty('tool_choice');
    });

    // Characterization: non-string, non-record values are not considered forcing and are kept.
    it.each([[null], [5]])('keeps odd tool_choice %j (characterization)', (toolChoice) => {
      const body = anthropicBody({ tool_choice: toolChoice });
      applyToolsGuard(body);
      expect(body.tool_choice).toBe(toolChoice);
    });

    it('leaves tool_choice untouched when the guard returns null', () => {
      const body = anthropicBody({ tools: [{ name: 'real' }], tool_choice: 'required' });
      expect(applyToolsGuard(body)).toBeNull();
      expect(body.tool_choice).toBe('required');
    });
  });
});
