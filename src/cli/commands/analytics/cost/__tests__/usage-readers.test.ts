/**
 * Per-agent token usage reader unit tests
 */

import { describe, it, expect } from 'vitest';
import { readUsageByModel, extractClaudeUsageRecords, gatherDedupedUsageRecords, sumUsageRecords } from '../usage-readers.js';

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

describe('extractClaudeUsageRecords — timestamps', () => {
  function parsed(messages: unknown[]): never {
    return { sessionId: 's', agentName: 'claude', metadata: {}, messages, metrics: {} } as never;
  }
  it('captures the message timestamp as epoch ms', () => {
    const recs = extractClaudeUsageRecords(parsed([
      { timestamp: '2026-06-08T10:00:00Z', message: { id: 'm1', model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 5 } } },
    ]));
    expect(recs).toHaveLength(1);
    expect(recs[0].ts).toBe(Date.parse('2026-06-08T10:00:00Z'));
  });
  it('sets ts null when the timestamp is missing/unparseable', () => {
    const recs = extractClaudeUsageRecords(parsed([
      { message: { id: 'm2', model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } } },
      { timestamp: 'not-a-date', message: { id: 'm3', model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]));
    expect(recs[0].ts).toBeNull();
    expect(recs[1].ts).toBeNull();
  });
});

describe('gatherDedupedUsageRecords + sumUsageRecords', () => {
  function claude(messages: unknown[]): never {
    return { sessionId: 's', agentName: 'claude', metadata: {}, messages, metrics: {} } as never;
  }
  const m = (id: string, ts: string, inp: number) => ({ timestamp: ts, requestId: 'r-' + id, message: { id, model: 'claude-sonnet-4-6', usage: { input_tokens: inp, output_tokens: 0 } } });

  it('returns ordered records and dedupes by key across the shared seen set', () => {
    const seen = new Set<string>();
    const a = gatherDedupedUsageRecords('claude', claude([m('m1', '2026-06-08T10:00:00Z', 10), m('m2', '2026-06-08T10:01:00Z', 20)]), seen);
    expect(a.map((r) => r.usage.input)).toEqual([10, 20]);
    // a resumed log replays m2 — already seen ⇒ only the new m3 survives
    const b = gatherDedupedUsageRecords('claude', claude([m('m2', '2026-06-08T10:01:00Z', 20), m('m3', '2026-06-08T10:02:00Z', 30)]), seen);
    expect(b.map((r) => r.usage.input)).toEqual([30]);
  });

  it('returns [] for a non-Claude agent', () => {
    expect(gatherDedupedUsageRecords('codex', claude([m('m1', '2026-06-08T10:00:00Z', 10)]), new Set())).toEqual([]);
  });

  it('sumUsageRecords reproduces per-model totals', () => {
    const recs = gatherDedupedUsageRecords('claude', claude([m('m1', '2026-06-08T10:00:00Z', 10), m('m2', '2026-06-08T10:01:00Z', 20)]), new Set());
    const map = sumUsageRecords(recs);
    expect(map.get('claude-sonnet-4-6')!.input).toBe(30);
  });
});

describe('extractClaudeUsageRecords — sub-agent transcripts', () => {
  const msg = (id: string, model: string, input: number, ts?: string) => ({
    ...(ts && { timestamp: ts }),
    requestId: 'r-' + id,
    message: { id, model, usage: { input_tokens: input, output_tokens: 0 } },
  });
  function parsed(
    messages: unknown[],
    subagents?: Array<{ agentId: string; filePath: string; messages: unknown[] }>
  ): never {
    return { sessionId: 's', agentName: 'claude', metadata: {}, messages, ...(subagents && { subagents }), metrics: {} } as never;
  }

  it('merges records from the main transcript and every sub-agent transcript', () => {
    const p = parsed(
      [msg('m1', 'claude-sonnet-4-6', 100)],
      [
        { agentId: 'a1', filePath: '/fake/s/subagents/agent-a1.jsonl', messages: [msg('s1', 'claude-sonnet-4-6', 200)] },
        { agentId: 'a2', filePath: '/fake/s/subagents/agent-a2.jsonl', messages: [msg('s2', 'claude-sonnet-4-6', 300)] },
      ]
    );
    const recs = extractClaudeUsageRecords(p);
    expect(recs).toHaveLength(3);
    expect(recs.reduce((n, r) => n + r.usage.input, 0)).toBe(600);
  });

  it('splits per-model totals when a sub-agent uses a different model', () => {
    const p = parsed(
      [msg('m1', 'claude-sonnet-4-6', 100)],
      [{ agentId: 'a1', filePath: '/fake/agent-a1.jsonl', messages: [msg('s1', 'claude-haiku-4-5', 50)] }]
    );
    const map = readUsageByModel('claude', p);
    expect(map.get('claude-sonnet-4-6')!.input).toBe(100);
    expect(map.get('claude-haiku-4-5')!.input).toBe(50);
  });

  it('dedupes a response present in both main and a sub-agent file; unique sub-agent work still counts', () => {
    const dup = msg('m1', 'claude-sonnet-4-6', 100);
    const p = parsed(
      [dup],
      [{ agentId: 'a1', filePath: '/fake/agent-a1.jsonl', messages: [dup, msg('s1', 'claude-sonnet-4-6', 40)] }]
    );
    const recs = gatherDedupedUsageRecords('claude', p, new Set());
    expect(recs.reduce((n, r) => n + r.usage.input, 0)).toBe(140); // not 240 (dup once), not 100 (sub-agent counted)
  });

  it('ignores a malformed sub-agent entry (non-array messages) without throwing', () => {
    const p = parsed(
      [msg('m1', 'claude-sonnet-4-6', 100)],
      [{ agentId: 'bad', filePath: '/fake/agent-bad.jsonl', messages: 'corrupt' as never }]
    );
    expect(extractClaudeUsageRecords(p)).toHaveLength(1);
  });

  it('sessions without subagents behave exactly as before (regression guard)', () => {
    const recs = extractClaudeUsageRecords(parsed([msg('m1', 'claude-sonnet-4-6', 100)]));
    expect(recs).toHaveLength(1);
    expect(recs[0].usage.input).toBe(100);
  });

  it('sorts merged records chronologically when every record is timed', () => {
    const p = parsed(
      [
        msg('m1', 'claude-sonnet-4-6', 1, '2026-06-08T10:00:00Z'),
        msg('m2', 'claude-sonnet-4-6', 2, '2026-06-08T10:04:00Z'),
      ],
      [{ agentId: 'a1', filePath: '/fake/agent-a1.jsonl', messages: [msg('s1', 'claude-sonnet-4-6', 3, '2026-06-08T10:02:00Z')] }]
    );
    // sub-agent record (10:02) lands between the two main records
    expect(extractClaudeUsageRecords(p).map((r) => r.usage.input)).toEqual([1, 3, 2]);
  });

  it('keeps concatenation order (main first) when any record lacks a timestamp', () => {
    const p = parsed(
      [msg('m1', 'claude-sonnet-4-6', 1, '2026-06-08T10:04:00Z')],
      [{ agentId: 'a1', filePath: '/fake/agent-a1.jsonl', messages: [msg('s1', 'claude-sonnet-4-6', 2)] }] // untimed
    );
    expect(extractClaudeUsageRecords(p).map((r) => r.usage.input)).toEqual([1, 2]);
  });
});
