/**
 * Per-agent token usage reader unit tests
 */

import { describe, it, expect } from 'vitest';
import { readUsageByModel } from '../usage-readers.js';

const claudeParsed = {
  sessionId: 's1',
  agentName: 'Claude Code',
  metadata: {},
  messages: [
    {
      message: {
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      },
    },
    { message: { model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 200, output_tokens: 80 } } },
    { message: { role: 'user', content: 'no usage here' } },
  ],
} as never;

const geminiParsed = {
  sessionId: 's2',
  agentName: 'Gemini CLI',
  metadata: {},
  messages: [
    { model: 'gemini-2.5-pro', tokens: { input: 300, output: 120, cached: 40, thoughts: 10, tool: 5, total: 475 } },
    { type: 'user', content: 'hi' },
  ],
} as never;

describe('readUsageByModel', () => {
  it('sums Claude usage per model', () => {
    const m = readUsageByModel('claude', claudeParsed);
    const u = m.get('claude-sonnet-4-5-20250929')!;
    expect(u.input).toBe(300);
    expect(u.output).toBe(130);
    expect(u.cacheRead).toBe(10);
    expect(u.cacheCreation).toBe(5);
    expect(u.total).toBe(445);
  });

  it('reads Gemini token usage', () => {
    const m = readUsageByModel('gemini', geminiParsed);
    const u = m.get('gemini-2.5-pro')!;
    expect(u.input).toBe(300);
    expect(u.output).toBe(120);
    expect(u.cacheRead).toBe(40);
    expect(u.total).toBe(475);
  });

  it('reads claude-desktop usage (Claude-shaped native logs)', () => {
    // claude-desktop's standard transcripts (~/.claude/projects/*.jsonl) have no SDK
    // result line, so it falls back to summing assistant message.usage like Claude Code.
    const m = readUsageByModel('claude-desktop', claudeParsed);
    const u = m.get('claude-sonnet-4-5-20250929')!;
    expect(u.input).toBe(300);
    expect(u.output).toBe(130);
    expect(u.total).toBe(445);
  });

  it('claude-desktop prefers the SDK result-line modelUsage over summed assistant usage', () => {
    // Claude-3p audit.jsonl carries an authoritative `result` line with modelUsage.
    // Summing the (streamed/sub-agent) assistant turns over-counts cache tokens, so the
    // result line must win when present.
    const sdkParsed = {
      sessionId: 'cd1',
      agentName: 'claude-desktop',
      metadata: {},
      messages: [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 999999, cache_creation_input_tokens: 888888 } } },
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 999999, cache_creation_input_tokens: 888888 } } },
        { type: 'result', modelUsage: { 'claude-sonnet-4-6': { inputTokens: 13, outputTokens: 3281, cacheReadInputTokens: 332529, cacheCreationInputTokens: 97809 } } },
      ],
    } as never;
    const u = readUsageByModel('claude-desktop', sdkParsed).get('claude-sonnet-4-6')!;
    expect(u.input).toBe(13);
    expect(u.output).toBe(3281);
    expect(u.cacheRead).toBe(332529);
    expect(u.cacheCreation).toBe(97809);
  });

  it('claude-desktop reads tokens from modelUsage when assistant turns carry none', () => {
    // Some audit.jsonl turns log zero usage on the assistant line; tokens live only in modelUsage.
    const sdkParsed = {
      messages: [
        { type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'result', modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 36558, outputTokens: 13, cacheCreationInputTokens: 36556 } } },
      ],
    } as never;
    const u = readUsageByModel('claude-desktop', sdkParsed).get('claude-haiku-4-5-20251001')!;
    expect(u.input).toBe(36558);
    expect(u.cacheCreation).toBe(36556);
  });

  it('skips synthetic Claude messages (not a billable model)', () => {
    const p = {
      messages: [
        { message: { model: '<synthetic>', usage: { input_tokens: 5, output_tokens: 5 } } },
        { message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 0 } } },
      ],
    } as never;
    const m = readUsageByModel('claude', p);
    expect(m.has('<synthetic>')).toBe(false);
    expect(m.get('claude-sonnet-4-5')!.input).toBe(100);
  });

  it('returns empty for an unsupported agent', () => {
    expect(readUsageByModel('mystery', claudeParsed).size).toBe(0);
  });
});
