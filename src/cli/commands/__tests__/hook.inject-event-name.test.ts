import { describe, it, expect } from 'vitest';
import { injectEventName } from '../hook.js';

describe('injectEventName', () => {
  it('stamps codemieEventName onto a parsed JSON object', () => {
    const result = injectEventName(JSON.stringify({ sessionId: 'sid-1', cwd: '/repo' }), 'preToolUse');

    expect(JSON.parse(result)).toEqual({ sessionId: 'sid-1', cwd: '/repo', codemieEventName: 'preToolUse' });
  });

  it("overwrites an existing codemieEventName field with --event's value", () => {
    const result = injectEventName(JSON.stringify({ codemieEventName: 'stale' }), 'sessionEnd');

    expect(JSON.parse(result)).toEqual({ codemieEventName: 'sessionEnd' });
  });

  it('falls back to the raw, unmodified input on unparsable JSON', () => {
    const raw = '{ not json';
    expect(injectEventName(raw, 'preToolUse')).toBe(raw);
  });

  it('falls back to the raw input when the parsed JSON is an array', () => {
    const raw = JSON.stringify([1, 2, 3]);
    expect(injectEventName(raw, 'preToolUse')).toBe(raw);
  });

  it('falls back to the raw input when the parsed JSON is not an object (string/number/null)', () => {
    expect(injectEventName(JSON.stringify('just a string'), 'preToolUse')).toBe(JSON.stringify('just a string'));
    expect(injectEventName(JSON.stringify(42), 'preToolUse')).toBe(JSON.stringify(42));
    expect(injectEventName(JSON.stringify(null), 'preToolUse')).toBe(JSON.stringify(null));
  });
});
