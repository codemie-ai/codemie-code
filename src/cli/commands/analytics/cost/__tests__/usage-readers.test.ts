/**
 * Per-agent token usage reader unit tests
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readUsageByModel, gatherUsageDeduped, extractClaudeUsageRecords, gatherDedupedUsageRecords, sumUsageRecords, extractKimiUsageRecords, extractCodexUsageRecords } from '../usage-readers.js';

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

  it('reads Kimi usage.record events', () => {
    const kimiParsed = {
      sessionId: 's3',
      agentName: 'kimi',
      metadata: {},
      messages: [
        { type: 'usage.record', model: 'kimi-code/kimi-for-coding', usage: { inputOther: 5505, output: 235, inputCacheRead: 15616, inputCacheCreation: 0 }, time: 1781517531246 },
        { type: 'usage.record', model: 'kimi-code/kimi-for-coding', usage: { inputOther: 8797, output: 144, inputCacheRead: 14336, inputCacheCreation: 0 }, time: 1781520494636 },
        { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Read' } },
      ],
    } as never;

    const m = readUsageByModel('kimi', kimiParsed);
    const u = m.get('kimi-code/kimi-for-coding')!;
    expect(u.input).toBe(14302);
    expect(u.output).toBe(379);
    expect(u.cacheRead).toBe(29952);
    expect(u.cacheCreation).toBe(0);
    expect(u.total).toBe(44633);
  });

  it('extracts Kimi usage records for per-turn cost series', () => {
    const kimiParsed = {
      sessionId: 's3',
      agentName: 'kimi',
      metadata: {},
      messages: [
        { type: 'usage.record', model: 'kimi-code/kimi-for-coding', usage: { inputOther: 100, output: 50, inputCacheRead: 10, inputCacheCreation: 5 }, time: 1781517531000 },
        { type: 'usage.record', model: 'kimi-code/kimi-for-coding', usage: { inputOther: 200, output: 80, inputCacheRead: 20, inputCacheCreation: 0 }, time: 1781517532000 },
      ],
    } as never;

    const recs = extractKimiUsageRecords(kimiParsed);
    expect(recs).toHaveLength(2);
    expect(recs[0].ts).toBe(1781517531000);
    expect(recs[0].usage.total).toBe(165);
    expect(recs[1].usage.total).toBe(300);
    expect(recs[0].key).toBeNull();
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

  it('keeps the most complete row when Claude writes progressive records for one response', () => {
    const recs = gatherDedupedUsageRecords(
      'claude',
      claude([
        { timestamp: '2026-06-08T10:00:00Z', requestId: 'req-1', message: { id: 'msg-1', model: 'claude-sonnet-4-6', usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 20_679, cache_creation_input_tokens: 2_682 } } },
        { timestamp: '2026-06-08T10:00:01Z', requestId: 'req-1', message: { id: 'msg-1', model: 'claude-sonnet-4-6', usage: { input_tokens: 3, output_tokens: 121, cache_read_input_tokens: 20_679, cache_creation_input_tokens: 2_682 } } },
      ]),
      new Set()
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].usage.output).toBe(121);
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

describe('extractClaudeUsageRecords — cacheCreation1h', () => {
  function parsed(messages: unknown[]): never {
    return { sessionId: 's', agentName: 'claude', metadata: {}, messages, metrics: {} } as never;
  }

  it('reads cacheCreation1h from cache_creation.ephemeral_1h_input_tokens', () => {
    const recs = extractClaudeUsageRecords(
      parsed([
        {
          requestId: 'r1',
          message: {
            id: 'm1',
            model: 'claude-sonnet-4-6',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 9275,
              cache_creation: { ephemeral_1h_input_tokens: 9275, ephemeral_5m_input_tokens: 0 },
            },
          },
        },
      ])
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].usage.cacheCreation1h).toBe(9275);
  });

  it('sets cacheCreation1h to 0 when cache_creation is absent', () => {
    const recs = extractClaudeUsageRecords(
      parsed([
        {
          requestId: 'r2',
          message: {
            id: 'm2',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
      ])
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].usage.cacheCreation1h).toBe(0);
  });

  it('accumulates cacheCreation1h across two messages (one 1h, one 5m)', () => {
    const recs = extractClaudeUsageRecords(
      parsed([
        {
          requestId: 'r3',
          message: {
            id: 'm3',
            model: 'claude-sonnet-4-6',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation: { ephemeral_1h_input_tokens: 5000, ephemeral_5m_input_tokens: 2000 },
            },
          },
        },
        {
          requestId: 'r4',
          message: {
            id: 'm4',
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 200, output_tokens: 80 },
          },
        },
      ])
    );
    expect(recs).toHaveLength(2);
    const total1h = recs.reduce((sum, r) => sum + r.usage.cacheCreation1h, 0);
    expect(total1h).toBe(5000);
  });
});

describe('extractCodexUsageRecords', () => {
  function loadCodex(name: string): never {
    const lines = readFileSync(join(process.cwd(), 'tests/integration/session/fixtures/codex', name), 'utf-8')
      .trim()
      .split('\n')
      .map((l: string) => JSON.parse(l));
    return { sessionId: 'codex-fixture', agentName: 'codex', metadata: { model: 'o4-mini' }, messages: lines, metrics: {} } as never;
  }

  it('maps token_count last_token_usage to usage records with cache read', () => {
    const recs = extractCodexUsageRecords(loadCodex('turn-1.jsonl'));
    expect(recs.length).toBeGreaterThanOrEqual(1);
    expect(recs[0].model).toBe('o4-mini');
    // Codex input_tokens (1024) INCLUDES cached_input_tokens (512); the reader subtracts cache so
    // the non-cached prompt is priced at the input rate and the cached portion only at cache-read.
    expect(recs[0].usage.input).toBe(512);
    expect(recs[0].usage.cacheRead).toBe(512);
  });

  it('readUsageByModel uses final total_token_usage for codex', () => {
    const m = readUsageByModel('codex', loadCodex('turn-2.jsonl'));
    const u = [...m.values()][0];
    expect(u?.total).toBeGreaterThan(1036);
  });

  it('readUsageByModel treats codemie-codex like codex', () => {
    const m = readUsageByModel('codemie-codex', loadCodex('turn-2.jsonl'));
    const u = [...m.values()][0];
    expect(u?.total).toBeGreaterThan(1036);
  });

  it('buildCostSeries works from codex per-turn records', async () => {
    const { buildCostSeries } = await import('../cost-enricher.js');
    const recs = extractCodexUsageRecords(loadCodex('turn-2.jsonl'));
    const series = buildCostSeries(recs);
    expect(series.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * GitHub Copilot CLI.
 *
 * Copilot reports usage in the OpenAI convention: `inputTokens` INCLUDES `cacheReadTokens`,
 * and it applies that convention to Anthropic models too. This repository's `costBreakdown`
 * bills `input` at full rate AND `cacheRead` separately — the Anthropic convention. The
 * reader must therefore decompose rather than pass through.
 *
 * Figures below reflect a real Copilot CLI 1.0.x session, retained because they are
 * the exact values that expose the cache-inclusive over-billing bug.
 */
const copilotParsed = {
  sessionId: 's-copilot',
  agentName: 'GitHub Copilot CLI',
  metadata: {},
  messages: [
    {
      model: 'gpt-5.2',
      requests: 374,
      usage: {
        inputTokens: 14076695,
        outputTokens: 173180,
        cacheReadTokens: 13694976,
        cacheWriteTokens: 0,
        reasoningTokens: 90359,
      },
    },
    {
      model: 'claude-sonnet-4.5',
      requests: 60,
      usage: {
        inputTokens: 1654378,
        outputTokens: 27215,
        cacheReadTokens: 1504366,
        cacheWriteTokens: 125660,
        reasoningTokens: 0,
      },
    },
  ],
} as never;

describe('readUsageByModel — copilot-cli cache decomposition', () => {
  it('subtracts cache reads from inputTokens instead of double-billing them', () => {
    const u = readUsageByModel('copilot-cli', copilotParsed).get('gpt-5.2')!;

    // 14,076,695 − 13,694,976 = 381,719. Passing the raw value through would
    // over-count the input component ~36x.
    expect(u.input).toBe(381719);
    expect(u.cacheRead).toBe(13694976);
    expect(u.output).toBe(173180);
    expect(u.cacheCreation).toBe(0);
  });

  it('splits fresh input into cache-write and plain input for Anthropic models', () => {
    const u = readUsageByModel('copilot-cli', copilotParsed).get('claude-sonnet-4.5')!;

    // fresh = 1,654,378 − 1,504,366 = 150,012, of which 125,660 were cache writes.
    expect(u.cacheCreation).toBe(125660);
    expect(u.input).toBe(24352);
    expect(u.cacheRead).toBe(1504366);
    expect(u.cacheCreation1h).toBe(0); // Copilot exposes no cache-TTL split
  });

  it('never bills reasoning tokens separately — they are inside outputTokens', () => {
    const u = readUsageByModel('copilot-cli', copilotParsed).get('gpt-5.2')!;
    expect(u.output).toBe(173180); // not 173180 + 90359
  });

  it('reports total as the sum of the decomposed components', () => {
    const u = readUsageByModel('copilot-cli', copilotParsed).get('gpt-5.2')!;
    expect(u.total).toBe(u.input + u.output + u.cacheRead + u.cacheCreation);
  });

  it('clamps to zero rather than going negative on inconsistent buckets', () => {
    const weird = {
      sessionId: 's-weird',
      agentName: 'GitHub Copilot CLI',
      metadata: {},
      messages: [
        { model: 'gpt-5.2', usage: { inputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 900 } },
      ],
    } as never;

    const u = readUsageByModel('copilot-cli', weird).get('gpt-5.2')!;
    expect(u.input).toBe(0);
    // Cache writes price ABOVE the base input rate, so a malformed transcript must not be
    // able to bill more of them than there was fresh input to write. Clamping input to 0
    // while still billing 900 cache-write tokens would over-charge on garbage data.
    expect(u.cacheCreation).toBe(0);
    expect(u.total).toBe(500); // cacheRead only
  });

  it('does not let cache writes exceed the fresh input they were written from', () => {
    const skewed = {
      sessionId: 's-skew',
      agentName: 'GitHub Copilot CLI',
      metadata: {},
      messages: [
        // fresh input = 1000 − 400 = 600, but the transcript claims 5000 cache writes.
        { model: 'gpt-5.2', usage: { inputTokens: 1000, cacheReadTokens: 400, cacheWriteTokens: 5000 } },
      ],
    } as never;

    const u = readUsageByModel('copilot-cli', skewed).get('gpt-5.2')!;
    expect(u.cacheCreation).toBe(600);
    expect(u.input).toBe(0);
  });

  it('leaves well-formed real-world buckets untouched by the clamp', () => {
    // Regression guard: the clamp must not alter the measured session's numbers.
    const u = readUsageByModel('copilot-cli', copilotParsed).get('claude-sonnet-4.5')!;
    expect(u.cacheCreation).toBe(125660);
    expect(u.input).toBe(24352);
  });

  it('handles the output-only partial shape from the per-turn fallback', () => {
    const partial = {
      sessionId: 's-partial',
      agentName: 'GitHub Copilot CLI',
      metadata: {},
      messages: [{ model: 'gpt-5.2', requests: 3, partial: true, usage: { outputTokens: 350 } }],
    } as never;

    const u = readUsageByModel('copilot-cli', partial).get('gpt-5.2')!;
    expect(u.output).toBe(350);
    expect(u.input).toBe(0);
    expect(u.cacheRead).toBe(0);
    expect(u.total).toBe(350);
  });

  it('sums repeated entries for the same model', () => {
    const dup = {
      sessionId: 's-dup',
      agentName: 'GitHub Copilot CLI',
      metadata: {},
      messages: [
        { model: 'gpt-5.2', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40 } },
        { model: 'gpt-5.2', usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 50 } },
      ],
    } as never;

    const u = readUsageByModel('copilot-cli', dup).get('gpt-5.2')!;
    expect(u.input).toBe(60 + 150);
    expect(u.output).toBe(30);
    expect(u.cacheRead).toBe(90);
  });

  it('folds sub-agent transcripts into the owning session', () => {
    const withSub = {
      sessionId: 's-sub',
      agentName: 'GitHub Copilot CLI',
      metadata: {},
      messages: [{ model: 'gpt-5.2', usage: { inputTokens: 100, outputTokens: 10 } }],
      subagents: [
        { agentId: 'a1', filePath: '/x', messages: [{ model: 'gpt-5.2', usage: { inputTokens: 50, outputTokens: 5 } }] },
      ],
    } as never;

    const u = readUsageByModel('copilot-cli', withSub).get('gpt-5.2')!;
    expect(u.input).toBe(150);
    expect(u.output).toBe(15);
  });

  it('skips entries with no model or no usage', () => {
    const junk = {
      sessionId: 's-junk',
      agentName: 'GitHub Copilot CLI',
      metadata: {},
      messages: [{ usage: { inputTokens: 5 } }, { model: 'gpt-5.2' }, 'not-an-object', null],
    } as never;

    expect(readUsageByModel('copilot-cli', junk).size).toBe(0);
  });

  it('returns an empty map for a session with no messages', () => {
    const empty = { sessionId: 's0', agentName: 'GitHub Copilot CLI', metadata: {}, messages: [] } as never;
    expect(readUsageByModel('copilot-cli', empty).size).toBe(0);
  });
});

/**
 * The cost enricher computes run-level totals through gatherUsageDeduped, NOT
 * readUsageByModel. An agent branched into one but not the other yields correct
 * per-session numbers and $0 report totals — a silent, plausible-looking failure.
 */
describe('gatherUsageDeduped — copilot-cli', () => {
  it('returns populated run-level totals (guards the $0-totals trap)', () => {
    const m = gatherUsageDeduped('copilot-cli', copilotParsed, new Set());

    expect(m.size).toBe(2);
    expect(m.get('gpt-5.2')!.input).toBe(381719);
    expect(m.get('claude-sonnet-4.5')!.cacheCreation).toBe(125660);
  });

  it('agrees with readUsageByModel', () => {
    const viaReader = readUsageByModel('copilot-cli', copilotParsed);
    const viaDedup = gatherUsageDeduped('copilot-cli', copilotParsed, new Set());
    expect([...viaDedup.entries()]).toEqual([...viaReader.entries()]);
  });

  it('is session-local — a shared seen set does not suppress a second session', () => {
    const seen = new Set<string>();
    const first = gatherUsageDeduped('copilot-cli', copilotParsed, seen);
    const second = gatherUsageDeduped('copilot-cli', copilotParsed, seen);
    expect(second.get('gpt-5.2')!.input).toBe(first.get('gpt-5.2')!.input);
  });
});
