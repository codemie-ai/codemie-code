/**
 * Cross-host disambiguation table for the three native hook-input type guards.
 *
 * Claude Code, VS Code Copilot Chat and GitHub Copilot CLI hook payloads deliberately share
 * field names (`session_id`/`cwd`/`hook_event_name` and overlapping event names like `Stop` /
 * `SubagentStart`), so each guard must reject the other two hosts' representative payloads —
 * not just accept its own. The three hosts are told apart by the `timestamp` field: absent for
 * Claude, a string for Chat, a number for Copilot CLI.
 */
import { describe, it, expect } from 'vitest';
import { isClaudeCodeHookInput } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.types.js';
import { isCopilotChatHookInput } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.types.js';
import { isCopilotCliHookInput } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.types.js';

const claudePayload = { session_id: 'sid-1', cwd: '/repo', hook_event_name: 'Stop' };
const chatPayload = { session_id: 'sid-1', cwd: '/repo', hook_event_name: 'Stop', timestamp: '2026-01-02T03:04:05.000Z' };
const cliPayload = { sessionId: 'sid-1', cwd: '/repo', codemieEventName: 'sessionEnd', timestamp: 1700000000000 };

describe('native hook-input type guards — cross-host disambiguation', () => {
  it.each([
    ['Claude', claudePayload, isClaudeCodeHookInput],
    ['Chat', chatPayload, isCopilotChatHookInput],
    ['CLI', cliPayload, isCopilotCliHookInput],
  ] as const)('%s guard accepts its own representative payload', (_label, payload, guard) => {
    expect(guard(payload)).toBe(true);
  });

  it.each([
    ['Claude', isClaudeCodeHookInput],
    ['CLI', isCopilotCliHookInput],
  ] as const)("%s guard rejects Chat's payload (string timestamp)", (_label, guard) => {
    expect(guard(chatPayload)).toBe(false);
  });

  it.each([
    ['Claude', isClaudeCodeHookInput],
    ['Chat', isCopilotChatHookInput],
  ] as const)("%s guard rejects CLI's payload (numeric timestamp)", (_label, guard) => {
    expect(guard(cliPayload)).toBe(false);
  });

  it.each([
    ['Chat', isCopilotChatHookInput],
    ['CLI', isCopilotCliHookInput],
  ] as const)("%s guard rejects Claude's payload (no timestamp at all)", (_label, guard) => {
    expect(guard(claudePayload)).toBe(false);
  });

  it('Claude rejects a payload carrying a timestamp key at all, even set to undefined', () => {
    expect(isClaudeCodeHookInput({ ...claudePayload, timestamp: undefined })).toBe(false);
  });

  it('Chat rejects a numeric timestamp on an otherwise-valid Chat-shaped payload', () => {
    expect(isCopilotChatHookInput({ ...chatPayload, timestamp: 1700000000000 })).toBe(false);
  });

  it('Chat rejects a missing timestamp on an otherwise-valid Chat-shaped payload', () => {
    const { timestamp: _timestamp, ...withoutTimestamp } = chatPayload;
    expect(isCopilotChatHookInput(withoutTimestamp)).toBe(false);
  });

  it('CLI rejects a string timestamp on an otherwise-valid CLI-shaped payload', () => {
    expect(isCopilotCliHookInput({ ...cliPayload, timestamp: '1700000000000' })).toBe(false);
  });

  it('CLI rejects a missing timestamp on an otherwise-valid CLI-shaped payload', () => {
    const { timestamp: _timestamp, ...withoutTimestamp } = cliPayload;
    expect(isCopilotCliHookInput(withoutTimestamp)).toBe(false);
  });
});
