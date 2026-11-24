import { describe, it, expect } from 'vitest';
import { isCopilotChatHookInput } from '../copilot-chat-otlp.types.js';

function hookInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'Stop',
    timestamp: '2026-01-02T03:04:05.000Z',
    session_id: 'sid-1',
    cwd: '/repo',
    ...overrides,
  };
}

describe('isCopilotChatHookInput', () => {
  it('accepts a payload with a recognized event name and a string timestamp', () => {
    expect(isCopilotChatHookInput(hookInput())).toBe(true);
  });

  it('rejects non-object values', () => {
    expect(isCopilotChatHookInput(null)).toBe(false);
    expect(isCopilotChatHookInput(undefined)).toBe(false);
    expect(isCopilotChatHookInput('not an object')).toBe(false);
    expect(isCopilotChatHookInput(42)).toBe(false);
  });

  it('rejects an unrecognized hook_event_name', () => {
    expect(isCopilotChatHookInput(hookInput({ hook_event_name: 'NotARealEvent' }))).toBe(false);
  });

  it('rejects a non-string hook_event_name', () => {
    expect(isCopilotChatHookInput(hookInput({ hook_event_name: 123 }))).toBe(false);
  });

  it('rejects a missing timestamp', () => {
    const { timestamp: _timestamp, ...rest } = hookInput();
    expect(isCopilotChatHookInput(rest)).toBe(false);
  });

  it('rejects a numeric timestamp (the Copilot CLI shape)', () => {
    expect(isCopilotChatHookInput(hookInput({ timestamp: 1700000000000 }))).toBe(false);
  });

  it('accepts a payload without session_id or cwd — they may be absent from enforcement payloads', () => {
    expect(isCopilotChatHookInput(hookInput({ session_id: undefined, cwd: undefined }))).toBe(true);
  });

  it.each(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'])(
    'accepts the %s event name',
    (eventName) => {
      expect(isCopilotChatHookInput(hookInput({ hook_event_name: eventName }))).toBe(true);
    }
  );
});
