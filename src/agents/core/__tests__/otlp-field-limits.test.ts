import { describe, it, expect } from 'vitest';
import {
  boundedText,
  maskAndBoundFields,
  MAX_PROMPT_CHARS,
  MAX_TOOL_FIELD_CHARS,
} from '../otlp-field-limits.js';

describe('boundedText', () => {
  it('returns an empty string for a missing value', () => {
    expect(boundedText(undefined, 10)).toBe('');
    expect(boundedText(null, 10)).toBe('');
  });

  it('serializes an object and cuts it to the limit', () => {
    expect(boundedText({ a: 'x'.repeat(50) }, 10)).toHaveLength(10);
  });

  it('drops a lone high surrogate left by the cut', () => {
    expect(boundedText('ab😀', 3)).toBe('ab');
  });
});

describe('maskAndBoundFields', () => {
  it('cuts each free-text field to its own limit', () => {
    const out = maskAndBoundFields({
      prompt: 'p'.repeat(MAX_PROMPT_CHARS + 50),
      tool_response: 'r'.repeat(MAX_TOOL_FIELD_CHARS + 50),
    });

    expect(String(out['prompt'])).toHaveLength(MAX_PROMPT_CHARS);
    expect(String(out['tool_response'])).toHaveLength(MAX_TOOL_FIELD_CHARS);
  });

  it('masks a secret before cutting, so a secret straddling the limit is not half shown', () => {
    const secret = 'ghp_' + 'A1b2C3d4E5'.repeat(4);
    const out = maskAndBoundFields({ tool_input: `${'x'.repeat(MAX_TOOL_FIELD_CHARS - 10)} token=${secret}` });

    expect(String(out['tool_input'])).not.toContain('ghp_');
  });

  it('masks error_message before cutting it', () => {
    const secret = 'sk-' + 'A1b2C3d4E5'.repeat(3);
    const out = maskAndBoundFields({ error_message: `${'x'.repeat(MAX_TOOL_FIELD_CHARS - 10)} ${secret}` });

    expect(String(out['error_message'])).not.toContain('sk-');
    expect(String(out['error_message']).length).toBeLessThanOrEqual(MAX_TOOL_FIELD_CHARS);
  });

  it('leaves identifier fields untouched and does not add absent text fields', () => {
    const out = maskAndBoundFields({ session_id: 'abc-123', tool_use_id: 'call_1', agent_id: 'agent-0001' });

    expect(out).toEqual({ session_id: 'abc-123', tool_use_id: 'call_1', agent_id: 'agent-0001' });
  });
});
