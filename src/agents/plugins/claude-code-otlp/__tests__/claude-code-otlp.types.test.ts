import { describe, it, expect } from 'vitest';
import { isClaudeCodeHookInput } from '../claude-code-otlp.types.js';

function hookInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'sid-1',
    cwd: '/repo',
    hook_event_name: 'Stop',
    ...overrides,
  };
}

describe('isClaudeCodeHookInput', () => {
  it('accepts a payload with the three required fields', () => {
    expect(isClaudeCodeHookInput(hookInput())).toBe(true);
  });

  it('rejects non-object values', () => {
    expect(isClaudeCodeHookInput(null)).toBe(false);
    expect(isClaudeCodeHookInput(undefined)).toBe(false);
    expect(isClaudeCodeHookInput('not an object')).toBe(false);
    expect(isClaudeCodeHookInput(42)).toBe(false);
  });

  it('rejects a payload missing cwd or hook_event_name', () => {
    expect(isClaudeCodeHookInput(hookInput({ cwd: undefined }))).toBe(false);
    expect(isClaudeCodeHookInput(hookInput({ hook_event_name: undefined }))).toBe(false);
  });

  it('rejects an empty session_id — it is used verbatim as a filename, so an empty value would collide every session onto one shared state file', () => {
    expect(isClaudeCodeHookInput(hookInput({ session_id: '' }))).toBe(false);
  });

  it('rejects a session_id carrying a path separator or a ".." segment (path traversal)', () => {
    for (const unsafe of ['../../x', '..\\x', 'a/b', 'a\\b', '..', 'foo/../bar']) {
      expect(isClaudeCodeHookInput(hookInput({ session_id: unsafe }))).toBe(false);
    }
  });

  it('accepts a normal UUID-shaped session_id', () => {
    expect(isClaudeCodeHookInput(hookInput({ session_id: 'dd7d411a-cb45-4cd4-a7df-8d0695546e55' }))).toBe(true);
  });

  it('rejects a non-string session_id', () => {
    expect(isClaudeCodeHookInput(hookInput({ session_id: 123 }))).toBe(false);
  });
});
