import { describe, it, expect } from 'vitest';
import { isCopilotCliHookInput } from '../copilot-cli-otlp.types.js';

function hookInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'sid-1',
    cwd: '/repo',
    timestamp: 1700000000000,
    codemieEventName: 'sessionEnd',
    ...overrides,
  };
}

describe('isCopilotCliHookInput', () => {
  it('accepts a payload with the four required fields', () => {
    expect(isCopilotCliHookInput(hookInput())).toBe(true);
  });

  it('rejects non-object values', () => {
    expect(isCopilotCliHookInput(null)).toBe(false);
    expect(isCopilotCliHookInput(undefined)).toBe(false);
    expect(isCopilotCliHookInput('not an object')).toBe(false);
    expect(isCopilotCliHookInput(42)).toBe(false);
  });

  it('rejects a missing or empty cwd', () => {
    expect(isCopilotCliHookInput(hookInput({ cwd: undefined }))).toBe(false);
    expect(isCopilotCliHookInput(hookInput({ cwd: '' }))).toBe(false);
  });

  it('rejects a missing or non-numeric timestamp', () => {
    expect(isCopilotCliHookInput(hookInput({ timestamp: undefined }))).toBe(false);
    expect(isCopilotCliHookInput(hookInput({ timestamp: '1700000000000' }))).toBe(false);
  });

  it('rejects an unrecognized codemieEventName', () => {
    expect(isCopilotCliHookInput(hookInput({ codemieEventName: 'notARealEvent' }))).toBe(false);
  });

  it('rejects an empty sessionId — it is used verbatim as a filename, so an empty value would collide every session onto one shared state file', () => {
    expect(isCopilotCliHookInput(hookInput({ sessionId: '' }))).toBe(false);
  });

  it('rejects a sessionId carrying a path separator or a ".." segment (path traversal)', () => {
    for (const unsafe of ['../../x', '..\\x', 'a/b', 'a\\b', '..', 'foo/../bar']) {
      expect(isCopilotCliHookInput(hookInput({ sessionId: unsafe }))).toBe(false);
    }
  });

  it('accepts a normal UUID-shaped sessionId', () => {
    expect(isCopilotCliHookInput(hookInput({ sessionId: 'dd7d411a-cb45-4cd4-a7df-8d0695546e55' }))).toBe(true);
  });

  it.each([
    'sessionStart', 'sessionEnd', 'userPromptTransformed', 'preToolUse', 'postToolUse',
    'postToolUseFailure', 'agentStop', 'subagentStart', 'subagentStop', 'errorOccurred',
    'preCompact', 'notification',
  ])('accepts the %s event name', (eventName) => {
    expect(isCopilotCliHookInput(hookInput({ codemieEventName: eventName }))).toBe(true);
  });
});
