/**
 * Cost enricher unit tests (dependency-injected — no fs/registry).
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { enrichCosts, buildCostSeries, realDeps, type EnricherDeps } from '../cost-enricher.js';
import { MAX_SERIES_POINTS } from '../types.js';
import type { UsageRecord } from '../usage-readers.js';

const raw = [{ sessionId: 's1', startEvent: { agentName: 'claude' }, deltas: [] }] as never[];

const baseDeps: EnricherDeps = {
  resolveAgentName: (r) => (r as { startEvent: { agentName: string } }).startEvent.agentName,
  loadAgentSessionFile: async () => '/fake/s1.jsonl',
  parseNative: async () =>
    ({
      sessionId: 's1',
      agentName: 'claude',
      metadata: {},
      messages: [{ message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }],
    }) as never,
};

describe('enrichCosts', () => {
  it('prices a session from its native log', async () => {
    const { index, summary } = await enrichCosts(raw, baseDeps);
    const c = index.get('s1')!;
    expect(c.priced).toBe(true);
    expect(c.costUSD).toBeCloseTo(3, 6); // 1M input @ $3/1M sonnet-4-5
    expect(c.tokens.input).toBe(1_000_000);
    expect(summary.pricedSessions).toBe(1);
    expect(summary.totalCostUSD).toBeCloseTo(3, 6);
  });

  it('marks a session unpriced when the native log is missing', async () => {
    const { index, summary } = await enrichCosts(raw, { ...baseDeps, loadAgentSessionFile: async () => null });
    expect(index.get('s1')!.priced).toBe(false);
    expect(summary.pricedSessions).toBe(0);
  });

  it('records hadLog per session (located native log vs not) for coverage', async () => {
    const mixed = [
      { sessionId: 's1', startEvent: { agentName: 'claude' }, deltas: [] },
      { sessionId: 's3', startEvent: { agentName: 'codex' }, deltas: [] }, // no native log
    ] as never[];
    const deps: EnricherDeps = {
      resolveAgentName: (r) => (r as { startEvent: { agentName: string } }).startEvent.agentName,
      loadAgentSessionFile: async (r) =>
        (r as { sessionId: string }).sessionId === 's3' ? null : '/fake/log.jsonl',
      parseNative: async (agentName) =>
        agentName === 'codex'
          ? null
          : ({
              sessionId: 'x',
              agentName,
              metadata: {},
              messages: [{ message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 1000, output_tokens: 0 } } }],
            } as never),
    };
    const { index } = await enrichCosts(mixed, deps);
    expect(index.get('s1')).toMatchObject({ priced: true, hadLog: true });
    expect(index.get('s3')).toMatchObject({ priced: false, hadLog: false });
  });

  it('prices a codex session from token_count events', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const lines = readFileSync(join(process.cwd(), 'tests/integration/session/fixtures/codex/turn-1.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const deps: EnricherDeps = {
      ...baseDeps,
      resolveAgentName: () => 'codex',
      parseNative: async () =>
        ({ sessionId: 's1', agentName: 'codex', metadata: { model: 'o4-mini' }, messages: lines, metrics: {} } as never),
    };
    const { index, summary } = await enrichCosts(raw, deps);
    const c = index.get('s1')!;
    expect(c.priced).toBe(true);
    expect(c.tokens.total).toBe(1036);
    expect(c.costUSD).toBeGreaterThan(0);
    expect(summary.pricedSessions).toBe(1);
  });

  it('folds codex sub-agent usage into the session total exactly once', async () => {
    // Parent transcript: one token_count turn (per-turn records → parent total 1036). Linked
    // sub-agent rollout: its own token_count total of 500. The session total must be 1036 + 500 —
    // the child counted ONCE: neither dropped (the original undercount) nor double-counted.
    const tokenCount = (input: number, output: number, total: number) => ({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: total },
          last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: total },
        },
      },
    });
    const parent = {
      sessionId: 's1',
      agentName: 'codex',
      metadata: { model: 'o4-mini' },
      messages: [
        { timestamp: '2026-06-08T10:00:00Z', type: 'turn_context', payload: { model: 'o4-mini' } },
        { timestamp: '2026-06-08T10:00:01Z', ...tokenCount(1000, 36, 1036) },
      ],
      subagents: [{ agentId: 'child', filePath: '/child.jsonl', messages: [tokenCount(500, 0, 500)] }],
      metrics: {},
    };
    const deps: EnricherDeps = {
      ...baseDeps,
      resolveAgentName: () => 'codex',
      parseNative: async () => parent as never,
    };
    const { index, summary } = await enrichCosts(raw, deps);
    const c = index.get('s1')!;
    expect(c.tokens.total).toBe(1536); // 1036 parent + 500 sub-agent, counted once
    expect(c.tokens.input).toBe(1500); // 1000 parent + 500 sub-agent
    expect(c.priced).toBe(true);
    expect(summary.pricedSessions).toBe(1);
  });

  it('marks a parsed codex session unpriced when token_count has no usage data', async () => {
    const deps: EnricherDeps = {
      ...baseDeps,
      resolveAgentName: () => 'codex',
      parseNative: async () =>
        ({ sessionId: 's1', agentName: 'codex', metadata: {}, messages: [{ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }], metrics: {} } as never),
    };
    const { index, summary } = await enrichCosts(raw, deps);
    expect(index.get('s1')!.hadLog).toBe(true);
    expect(index.get('s1')!.priced).toBe(false);
    expect(index.get('s1')!.costUSD).toBe(0);
    expect(summary.pricedSessions).toBe(0);
  });

  it('prices codemie-codex sessions with the codex usage reader', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const lines = readFileSync(join(process.cwd(), 'tests/integration/session/fixtures/codex/turn-1.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const deps: EnricherDeps = {
      ...baseDeps,
      resolveAgentName: () => 'codemie-codex',
      parseNative: async () =>
        ({ sessionId: 's1', agentName: 'codemie-codex', metadata: { model: 'o4-mini' }, messages: lines, metrics: {} } as never),
    };
    const { index } = await enrichCosts(raw, deps);
    expect(index.get('s1')!.priced).toBe(true);
    expect(index.get('s1')!.costUSD).toBeGreaterThan(0);
  });

  it('dedupes the same API response across resumed sessions (counts once, earliest owns it)', async () => {
    // sessionB resumes sessionA and replays A's assistant response (same message.id + requestId).
    const shared = { type: 'assistant', requestId: 'req-1', message: { id: 'msg-1', model: 'claude-sonnet-4-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } };
    const uniqueB = { type: 'assistant', requestId: 'req-2', message: { id: 'msg-2', model: 'claude-sonnet-4-5', usage: { input_tokens: 500_000, output_tokens: 0 } } };
    const raws = [
      { sessionId: 'A', startEvent: { agentName: 'claude', data: { startTime: 1000 } }, deltas: [] },
      { sessionId: 'B', startEvent: { agentName: 'claude', data: { startTime: 2000 } }, deltas: [] },
    ] as never[];
    const deps: EnricherDeps = {
      resolveAgentName: () => 'claude',
      loadAgentSessionFile: async () => '/fake/log.jsonl',
      parseNative: async (_agent, _file, sid) =>
        ({
          sessionId: sid,
          agentName: 'claude',
          metadata: {},
          messages: sid === 'A' ? [shared] : [shared, uniqueB],
        }) as never,
    };
    const { index, summary } = await enrichCosts(raws, deps);
    expect(index.get('A')!.costUSD).toBeCloseTo(3, 6); // earliest owns the shared 1M input @ $3/1M
    expect(index.get('B')!.costUSD).toBeCloseTo(1.5, 6); // shared deduped; only B's unique 0.5M counts
    expect(summary.totalCostUSD).toBeCloseTo(4.5, 6); // each unique response counted once (not 7.5)
  });

  it('breaks out cache-read cost per session', async () => {
    const deps: EnricherDeps = {
      ...baseDeps,
      parseNative: async () =>
        ({
          sessionId: 's1', agentName: 'claude', metadata: {},
          messages: [{ message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 } } }],
        }) as never,
    };
    const { index } = await enrichCosts(raw, deps);
    const c = index.get('s1')!;
    expect(c.cacheReadCostUSD).toBeGreaterThan(0);
    // only cache reads present, so cache-read cost == total cost
    expect(c.cacheReadCostUSD).toBeCloseTo(c.costUSD, 6);
  });

  it('cacheReadCostUSD is 0 for an unpriced session', async () => {
    const { index } = await enrichCosts(raw, { ...baseDeps, loadAgentSessionFile: async () => null });
    expect(index.get('s1')!.cacheReadCostUSD).toBe(0);
  });

  it('records unpriced models without throwing', async () => {
    const deps: EnricherDeps = {
      ...baseDeps,
      parseNative: async () =>
        ({
          sessionId: 's1',
          agentName: 'claude',
          metadata: {},
          messages: [{ message: { model: 'no-such-model-xyz', usage: { input_tokens: 10, output_tokens: 5 } } }],
        }) as never,
    };
    const { index, summary } = await enrichCosts(raw, deps);
    expect(index.get('s1')!.priced).toBe(true);
    expect(index.get('s1')!.costUSD).toBe(0);
    expect(summary.unpricedModels).toContain('no-such-model-xyz');
  });

  it('costSeries endpoint equals the session total (same records, same pricing)', async () => {
    const deps: EnricherDeps = {
      ...baseDeps,
      parseNative: async () =>
        ({
          sessionId: 's1', agentName: 'claude', metadata: {},
          messages: [
            { timestamp: '2026-06-08T10:00:00Z', message: { id: 'm1', model: 'claude-sonnet-4-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } },
            { timestamp: '2026-06-08T10:05:00Z', message: { id: 'm2', model: 'claude-sonnet-4-5', usage: { input_tokens: 500_000, output_tokens: 0 } } },
          ],
        }) as never,
    };
    const { index } = await enrichCosts(raw, deps);
    const c = index.get('s1')!;
    expect(c.costSeries).toBeDefined();
    const last = c.costSeries![c.costSeries!.length - 1];
    expect(last.cost).toBeCloseTo(c.costUSD, 6); // float: per-record sum vs single multiply
    expect(last.tokens).toBe(c.tokens.total); // integer token sums are exact
    expect(c.costSeries![0].t).toBe(Date.parse('2026-06-08T10:00:00Z')); // real time axis when all records timed
  });

  it('omits costSeries for a single-record session (< 2 points)', async () => {
    const { index } = await enrichCosts(raw, baseDeps); // baseDeps = exactly one usage message
    expect(index.get('s1')!.costSeries).toBeUndefined();
  });

  it('folds sub-agent usage into the session total; series endpoint equals it', async () => {
    const deps: EnricherDeps = {
      ...baseDeps,
      parseNative: async () =>
        ({
          sessionId: 's1', agentName: 'claude', metadata: {},
          messages: [
            { timestamp: '2026-06-08T10:00:00Z', requestId: 'r1', message: { id: 'm1', model: 'claude-sonnet-4-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } },
            { timestamp: '2026-06-08T10:06:00Z', requestId: 'r2', message: { id: 'm2', model: 'claude-sonnet-4-5', usage: { input_tokens: 500_000, output_tokens: 0 } } },
          ],
          subagents: [{
            agentId: 'a1', filePath: '/fake/s1/subagents/agent-a1.jsonl',
            messages: [
              { timestamp: '2026-06-08T10:03:00Z', requestId: 'r3', message: { id: 'sub1', model: 'claude-sonnet-4-5', usage: { input_tokens: 2_000_000, output_tokens: 0 } } },
            ],
          }],
        }) as never,
    };
    const { index } = await enrichCosts(raw, deps);
    const c = index.get('s1')!;
    expect(c.tokens.input).toBe(3_500_000); // 1.5M main + 2M sub-agent
    expect(c.costUSD).toBeCloseTo(10.5, 6); // 3.5M input @ $3/1M sonnet-4-5
    const series = c.costSeries!;
    expect(series[series.length - 1].cost).toBeCloseTo(c.costUSD, 6); // endpoint invariant
    expect(series[series.length - 1].tokens).toBe(c.tokens.total);
    const axis = series.map((p) => p.t);
    expect([...axis].sort((a, b) => a - b)).toEqual(axis); // sub-agent record interleaved in time order
  });

  it('sub-agent records join the cross-session dedup (replayed response counted once)', async () => {
    const shared = { timestamp: '2026-06-08T10:00:00Z', requestId: 'req-1', message: { id: 'msg-1', model: 'claude-sonnet-4-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } };
    const raws = [
      { sessionId: 'A', startEvent: { agentName: 'claude', data: { startTime: 1000 } }, deltas: [] },
      { sessionId: 'B', startEvent: { agentName: 'claude', data: { startTime: 2000 } }, deltas: [] },
    ] as never[];
    const deps: EnricherDeps = {
      resolveAgentName: () => 'claude',
      loadAgentSessionFile: async () => '/fake/log.jsonl',
      parseNative: async (_agent, _file, sid) =>
        sid === 'A'
          ? ({
              sessionId: 'A', agentName: 'claude', metadata: {}, messages: [],
              subagents: [{ agentId: 'a1', filePath: '/fake/agent-a1.jsonl', messages: [shared] }],
            } as never)
          : ({ sessionId: 'B', agentName: 'claude', metadata: {}, messages: [shared] } as never),
    };
    const { index, summary } = await enrichCosts(raws, deps);
    expect(index.get('A')!.costUSD).toBeCloseTo(3, 6); // earliest session owns it — via its sub-agent
    expect(index.get('B')!.costUSD).toBe(0); // replay deduped
    expect(summary.totalCostUSD).toBeCloseTo(3, 6);
  });
});

describe('enrichCosts — dispatch cost attribution', () => {
  it('attributes cost, tokens, and tools to a dispatch when subagent matches by toolUseId', async () => {
    const subagentMessages = [
      {
        timestamp: '2026-06-08T10:02:00Z',
        requestId: 'req-sub-1',
        message: {
          id: 'msg-sub-1',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 100_000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
            { type: 'tool_use', id: 'tool-2', name: 'Bash', input: {} },
            { type: 'tool_use', id: 'tool-3', name: 'Read', input: {} },
          ],
        },
      },
    ];

    const deps: EnricherDeps = {
      resolveAgentName: () => 'claude',
      loadAgentSessionFile: async () => '/fake/parent.jsonl',
      parseNative: async () =>
        ({
          sessionId: 'parent-1',
          agentName: 'claude',
          metadata: {},
          messages: [
            {
              timestamp: '2026-06-08T10:00:00Z',
              message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'toolu_dispatch_1', name: 'Agent', input: { subagent_type: 'tech-analyst' } }],
              },
            },
            {
              timestamp: '2026-06-08T10:05:00Z',
              message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_dispatch_1', content: 'done' }],
              },
            },
          ],
          subagents: [
            {
              agentId: 'agent-abc',
              filePath: '/fake/parent-1/subagents/agent-abc.jsonl',
              messages: subagentMessages,
              toolUseId: 'toolu_dispatch_1',
              agentType: 'tech-analyst',
            },
          ],
        }) as never,
    };

    const rawSession = [{ sessionId: 'parent-1', startEvent: { agentName: 'claude' }, deltas: [] }] as never[];
    const { index } = await enrichCosts(rawSession, deps);
    const cost = index.get('parent-1')!;

    expect(cost.priced).toBe(true);
    expect(cost.dispatches).toBeDefined();
    const dispatch = cost.dispatches!.find(d => d.name === 'tech-analyst');
    expect(dispatch).toBeDefined();
    expect(dispatch!.costUSD).toBeGreaterThan(0);
    expect(dispatch!.tokens?.input).toBe(100_000);
    expect(dispatch!.tokens?.output).toBe(500);

    expect(dispatch!.tools).toBeDefined();
    const readTool = dispatch!.tools!.find(t => t.name === 'Read');
    const bashTool = dispatch!.tools!.find(t => t.name === 'Bash');
    expect(readTool?.calls).toBe(2);
    expect(bashTool?.calls).toBe(1);

    // _toolUseId must NOT be in the stored dispatch (stripped before storage)
    expect((dispatch as { _toolUseId?: string })._toolUseId).toBeUndefined();
  });

  it('leaves dispatch cost undefined when no subagent matches (graceful degradation)', async () => {
    const deps: EnricherDeps = {
      resolveAgentName: () => 'claude',
      loadAgentSessionFile: async () => '/fake/parent.jsonl',
      parseNative: async () =>
        ({
          sessionId: 'parent-2',
          agentName: 'claude',
          metadata: {},
          messages: [
            {
              timestamp: '2026-06-08T10:00:00Z',
              message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'toolu_no_meta', name: 'Agent', input: { subagent_type: 'Explore' } }],
              },
            },
            {
              timestamp: '2026-06-08T10:01:00Z',
              message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_no_meta', content: 'done' }],
              },
            },
          ],
          subagents: undefined,
        }) as never,
    };

    const rawSession = [{ sessionId: 'parent-2', startEvent: { agentName: 'claude' }, deltas: [] }] as never[];
    const { index } = await enrichCosts(rawSession, deps);
    const cost = index.get('parent-2')!;

    const dispatch = cost.dispatches?.find(d => d.name === 'Explore');
    expect(dispatch).toBeDefined();
    expect(dispatch!.costUSD).toBeUndefined();
    expect(dispatch!.tokens).toBeUndefined();
    expect(dispatch!.tools).toBeUndefined();
  });

  it('attributes cost to a skill dispatch from the session\'s own usage records in its time window', async () => {
    const deps: EnricherDeps = {
      resolveAgentName: () => 'claude',
      loadAgentSessionFile: async () => '/fake/parent.jsonl',
      parseNative: async () =>
        ({
          sessionId: 'parent-3',
          agentName: 'claude',
          metadata: {},
          messages: [
            {
              timestamp: '2026-06-08T10:00:00Z',
              message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'toolu_skill_1', name: 'Skill', input: { skill: 'code-review' } }],
              },
            },
            // Inside the skill's window [10:00:00, 10:00:30] — must be attributed.
            {
              timestamp: '2026-06-08T10:00:10Z',
              requestId: 'req-skill-1',
              message: { id: 'msg-skill-1', role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 200_000, output_tokens: 0 } },
            },
            {
              timestamp: '2026-06-08T10:00:30Z',
              message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_skill_1', content: 'done' }],
              },
            },
            // Outside the skill's window (after it ends) — must NOT be attributed.
            {
              timestamp: '2026-06-08T10:05:00Z',
              requestId: 'req-after',
              message: { id: 'msg-after', role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
            },
          ],
        }) as never,
    };

    const rawSession = [{ sessionId: 'parent-3', startEvent: { agentName: 'claude' }, deltas: [] }] as never[];
    const { index } = await enrichCosts(rawSession, deps);
    const cost = index.get('parent-3')!;

    const dispatch = cost.dispatches!.find((d) => d.kind === 'skill' && d.name === 'code-review');
    expect(dispatch).toBeDefined();
    expect(dispatch!.tokens?.input).toBe(200_000); // only the in-window record, not the 1M after
    expect(dispatch!.costUSD).toBeCloseTo(0.6, 6); // 200k input @ $3/1M sonnet-4-5
  });

  it('leaves skill dispatch cost undefined when durationMs is 0 (no window to attribute from)', async () => {
    const deps: EnricherDeps = {
      resolveAgentName: () => 'claude',
      loadAgentSessionFile: async () => '/fake/parent.jsonl',
      parseNative: async () =>
        ({
          sessionId: 'parent-4',
          agentName: 'claude',
          metadata: {},
          messages: [
            {
              timestamp: '2026-06-08T10:00:00Z',
              message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'toolu_skill_2', name: 'Skill', input: { skill: 'orphan-skill' } }],
              },
            },
            // No matching tool_result → 0-duration marker (dispatch-extractor.ts line 105).
          ],
        }) as never,
    };
    const rawSession = [{ sessionId: 'parent-4', startEvent: { agentName: 'claude' }, deltas: [] }] as never[];
    const { index } = await enrichCosts(rawSession, deps);
    const cost = index.get('parent-4')!;
    const dispatch = cost.dispatches!.find((d) => d.kind === 'skill' && d.name === 'orphan-skill');
    expect(dispatch).toBeDefined();
    expect(dispatch!.costUSD).toBeUndefined();
    expect(dispatch!.tokens).toBeUndefined();
  });
});

describe('acceptance: TTL-aware pricing against real transcripts', () => {
  const BASE = `${process.env.HOME}/.claude/projects/${process.cwd().replace(/[/_]/g, '-')}`;

  // Skip in CI or when local Claude transcripts are not present.
  const itLocal = process.env.CI ? it.skip : it;

  function hasTranscripts(paths: string[]): boolean {
    return paths.every((p) => existsSync(p));
  }

  function sessionEntry(sessionId: string, filePath: string, agentName = 'claude', startTime = 1) {
    return {
      sessionId,
      agentSessionFile: filePath,
      startEvent: { agentName, data: { startTime } },
      deltas: [],
    };
  }

  itLocal('session 6e8bfbe2: TTL-aware pricing yields the correct total', async () => {
    const sessions = [
      sessionEntry('6e8bfbe2-7a9a-4b1d-800b-ae72ee6dec9d', `${BASE}/6e8bfbe2-7a9a-4b1d-800b-ae72ee6dec9d.jsonl`),
      sessionEntry('agent-a66f1ecadbe8beed6', `${BASE}/6e8bfbe2-7a9a-4b1d-800b-ae72ee6dec9d/subagents/agent-a66f1ecadbe8beed6.jsonl`, 'claude', 2),
    ];
    if (!hasTranscripts(sessions.map((s) => s.agentSessionFile))) {
      return;
    }
    const { index } = await enrichCosts(sessions, realDeps);
    const total = [...index.values()].reduce((s, c) => s + c.costUSD, 0);
    expect(total).toBeCloseTo(4.88435635, 3);
  });

  itLocal('session d3128339: TTL-aware pricing yields the correct total', async () => {
    const sessions = [
      sessionEntry('d3128339-ed05-41d5-98b0-2a89932b4d3b', `${BASE}/d3128339-ed05-41d5-98b0-2a89932b4d3b.jsonl`),
      sessionEntry('agent-a0444580f67c6ec00', `${BASE}/d3128339-ed05-41d5-98b0-2a89932b4d3b/subagents/agent-a0444580f67c6ec00.jsonl`, 'claude', 2),
      sessionEntry('agent-a2b09a8c62ba62d84', `${BASE}/d3128339-ed05-41d5-98b0-2a89932b4d3b/subagents/agent-a2b09a8c62ba62d84.jsonl`, 'claude', 3),
    ];
    if (!hasTranscripts(sessions.map((s) => s.agentSessionFile))) {
      return;
    }
    const { index } = await enrichCosts(sessions, realDeps);
    const total = [...index.values()].reduce((s, c) => s + c.costUSD, 0);
    expect(total).toBeCloseTo(1.27628500, 3);
  });
});

describe('buildCostSeries', () => {
  const rec = (ts: number | null, model: string, input: number): UsageRecord =>
    ({ key: null, ts, model, usage: { input, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, total: input } });

  it('emits a cumulative series; final point equals the summed tokens', () => {
    const s = buildCostSeries([rec(1000, 'claude-sonnet-4-6', 10), rec(2000, 'claude-sonnet-4-6', 20)]);
    expect(s).toHaveLength(2);
    expect(s[0].t).toBe(1000);
    expect(s[1].tokens).toBe(30); // cumulative
    expect(s[1].cost).toBeGreaterThanOrEqual(s[0].cost); // monotonic
  });
  it('returns [] for fewer than 2 records', () => {
    expect(buildCostSeries([rec(1000, 'claude-sonnet-4-6', 10)])).toEqual([]);
  });
  it('falls back to 1-based ordinals when any record lacks a timestamp', () => {
    const s = buildCostSeries([rec(null, 'claude-sonnet-4-6', 10), rec(2000, 'claude-sonnet-4-6', 20)]);
    expect(s.map((p) => p.t)).toEqual([1, 2]);
  });
  it('downsamples to MAX_SERIES_POINTS keeping first and last', () => {
    const many = Array.from({ length: 200 }, (_, i) => rec(i + 1, 'claude-sonnet-4-6', 1));
    const s = buildCostSeries(many);
    expect(s.length).toBeLessThanOrEqual(MAX_SERIES_POINTS);
    expect(s[0].t).toBe(1);
    expect(s[s.length - 1].t).toBe(200);
    expect(s[s.length - 1].tokens).toBe(200); // last cumulative total preserved
  });
});
