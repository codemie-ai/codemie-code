/**
 * Cost enricher unit tests (dependency-injected — no fs/registry).
 */

import { describe, it, expect } from 'vitest';
import { enrichCosts, buildCostSeries, type EnricherDeps } from '../cost-enricher.js';
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

  it('marks a parsed session unpriced when the agent has no usage reader', async () => {
    // codex/opencode parse fine but have no usage reader → empty usage map. Such a session
    // must be hadLog=true, priced=false (so coverage shows "no token reader", not "✓ full $0").
    const deps: EnricherDeps = {
      ...baseDeps,
      resolveAgentName: () => 'codex',
      parseNative: async () =>
        ({ sessionId: 's1', agentName: 'codex', metadata: {}, messages: [{ message: { content: 'no usage' } }] } as never),
    };
    const { index, summary } = await enrichCosts(raw, deps);
    expect(index.get('s1')!.hadLog).toBe(true);
    expect(index.get('s1')!.priced).toBe(false);
    expect(index.get('s1')!.costUSD).toBe(0);
    expect(summary.pricedSessions).toBe(0);
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
});

describe('buildCostSeries', () => {
  const rec = (ts: number | null, model: string, input: number): UsageRecord =>
    ({ key: null, ts, model, usage: { input, output: 0, cacheRead: 0, cacheCreation: 0, total: input } });

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
