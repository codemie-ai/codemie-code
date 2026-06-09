/**
 * Cost enricher unit tests (dependency-injected — no fs/registry).
 */

import { describe, it, expect } from 'vitest';
import { enrichCosts, type EnricherDeps } from '../cost-enricher.js';

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
});
