import { describe, expect, it } from 'vitest';
import { parseWorkflowInput } from './workflow-input.js';

describe('parseWorkflowInput', () => {
  it('parses JSON object input', () => {
    expect(parseWorkflowInput('{"key":"value"}')).toEqual({ key: 'value' });
  });

  it('keeps non-JSON input as a string', () => {
    expect(parseWorkflowInput('hello workflow')).toBe('hello workflow');
  });

  it('returns undefined when input is omitted', () => {
    expect(parseWorkflowInput()).toBeUndefined();
  });
});
