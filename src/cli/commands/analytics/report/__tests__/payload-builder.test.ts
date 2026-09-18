/**
 * Report payload builder unit tests
 */

import { describe, it, expect } from 'vitest';
import { buildPayload } from '../payload-builder.js';
import type { RootAnalytics } from '../../types.js';
import type { SessionCostIndex, CostSummary, SessionCost, DispatchEvent } from '../../cost/types.js';

function session(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 's1',
    agentName: 'claude',
    provider: 'sso',
    workingDirectory: '/repo/app',
    startTime: 1700000000000,
    endTime: 1700000060000,
    duration: 60000,
    totalTurns: 5,
    totalFileOperations: 2,
    totalLinesAdded: 12,
    totalLinesRemoved: 2,
    totalLinesModified: 0,
    netLinesChanged: 10,
    filesChanged: 2,
    filesWritten: 1,
    filesEdited: 1,
    totalToolCalls: 4,
    successfulToolCalls: 4,
    failedToolCalls: 0,
    toolSuccessRate: 100,
    models: [{ model: 'claude-sonnet-4-5', calls: 5, percentage: 100 }],
    tools: [],
    files: [],
    languages: [{ language: 'typescript', filesCreated: 1, filesModified: 0, linesAdded: 12, linesRemoved: 0, percentage: 100 }],
    formats: [],
    skillInvocations: [],
    agentInvocations: [],
    commandInvocations: [],
    ...over,
  };
}

const root = {
  totalSessions: 1,
  totalDuration: 60000,
  totalTurns: 5,
  totalFileOperations: 2,
  totalLinesAdded: 12,
  totalLinesRemoved: 2,
  totalLinesModified: 0,
  netLinesChanged: 10,
  totalToolCalls: 4,
  successfulToolCalls: 4,
  failedToolCalls: 0,
  toolSuccessRate: 100,
  models: [],
  tools: [],
  languages: [],
  formats: [],
  projects: [
    {
      projectPath: '/repo/app',
      branches: [{ branchName: 'main', sessions: [session()] }],
    },
  ],
} as unknown as RootAnalytics;

const costIndex: SessionCostIndex = new Map([
  ['s1', { sessionId: 's1', tokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, total: 150 }, costUSD: 0.001, perModel: [], priced: true, hadLog: true }],
]);
const summary: CostSummary = {
  totalCostUSD: 0.001,
  pricedSessions: 1,
  totalSessions: 1,
  unpricedModels: [],
};

// Shared timestamps and cost helpers for period-derivation tests.
const T0 = 1_700_000_000_000;
const T_PLUS_5M = T0 + 5 * 60_000;
const T_PLUS_10M = T0 + 10 * 60_000;
const HALF_MIN = 30_000;
const ONE_MIN = 60_000;

function pricedCost(id: string) {
  return { sessionId: id, tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true };
}
function pricedIndex(...ids: string[]): SessionCostIndex {
  return new Map(ids.map((id) => [id, pricedCost(id)]));
}
function singleBranchRoot(sessions: Record<string, unknown>[]): RootAnalytics {
  return {
    ...root,
    projects: [{ projectPath: '/repo/app', branches: [{ branchName: 'main', sessions }] }],
  } as unknown as RootAnalytics;
}

describe('buildPayload', () => {
  it('flattens sessions and joins cost + meta', () => {
    const payload = buildPayload(root, costIndex, summary, {
      rangeLabel: 'all',
      projectFilter: 'all',
      generatedAt: '2026-06-08T00:00:00Z',
    });
    expect(payload.sessions).toHaveLength(1);
    const s = payload.sessions[0];
    expect(s.project).toBe('/repo/app');
    expect(s.branch).toBe('main');
    expect(s.netLines).toBe(10);
    expect(s.models).toEqual(['claude-sonnet-4-5']);
    expect(s.languages).toEqual(['typescript']);
    expect(s.costUSD).toBeCloseTo(0.001, 6);
    expect(payload.meta.totals.totalCostUSD).toBeCloseTo(0.001, 6);
    expect(payload.meta.agents).toContain('claude');
    expect(payload.meta.generatedAt).toBe('2026-06-08T00:00:00Z');
    expect(payload.meta.coverage).toEqual([{ agentName: 'claude', total: 1, priced: 1, withLog: 1 }]);
  });

  it('builds per-agent coverage over the deduped set (consistent with headline)', () => {
    const multiAgent = {
      ...root,
      projects: [
        {
          projectPath: '/repo/app',
          branches: [
            { branchName: 'main', sessions: [session({ sessionId: 's1', agentName: 'claude' }), session({ sessionId: 's2', agentName: 'codex' })] },
          ],
        },
      ],
    } as unknown as RootAnalytics;
    const idx: SessionCostIndex = new Map([
      ['s1', { sessionId: 's1', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0.01, perModel: [], priced: true, hadLog: true }],
      // codex: native log located but no usage reader → priced=false, hadLog=true
      ['s2', { sessionId: 's2', tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 }, costUSD: 0, perModel: [], priced: false, hadLog: true }],
    ]);
    const payload = buildPayload(multiAgent, idx, summary, { rangeLabel: 'all', projectFilter: 'all', generatedAt: '2026-06-08T00:00:00Z' });
    const byAgent = Object.fromEntries(payload.meta.coverage.map((c) => [c.agentName, c]));
    expect(byAgent['claude']).toEqual({ agentName: 'claude', total: 1, priced: 1, withLog: 1 });
    expect(byAgent['codex']).toEqual({ agentName: 'codex', total: 1, priced: 0, withLog: 1 });
    // coverage totals must equal the displayed session count (consistency invariant)
    const covTotal = payload.meta.coverage.reduce((a, c) => a + c.total, 0);
    expect(covTotal).toBe(payload.meta.totals.sessions);
  });

  it('dedupes a session that spans multiple branches and counts it once', () => {
    // Same session placed under two branches with full (duplicated) metrics — the
    // aggregator's hierarchy does this; flattening naively would 2x everything.
    const multiBranch = {
      ...root,
      projects: [
        {
          projectPath: '/repo/app',
          branches: [
            { branchName: 'main', sessions: [session()] },
            { branchName: 'feature/x', sessions: [session()] },
          ],
        },
      ],
    } as unknown as RootAnalytics;

    const payload = buildPayload(multiBranch, costIndex, summary, {
      rangeLabel: 'all',
      projectFilter: 'all',
      generatedAt: '2026-06-08T00:00:00Z',
    });

    expect(payload.sessions).toHaveLength(1); // not 2
    expect(payload.meta.totals.sessions).toBe(1);
    expect(payload.meta.totals.turns).toBe(5); // not 10
    expect(payload.meta.totals.totalCostUSD).toBeCloseTo(0.001, 6); // counted once
    // headline totals must equal the sum of the visible records (internal consistency)
    const visibleCost = payload.sessions.reduce((a, s) => a + s.costUSD, 0);
    expect(payload.meta.totals.totalCostUSD).toBeCloseTo(visibleCost, 6);
  });

  it('labels a multi-branch session with its dominant branch, not the first one seen', () => {
    // A session that did most of its work on feature/x but also touched main appears under
    // both branches in the hierarchy. The flat record must use the dominant (primary) branch
    // so the work is not mis-attributed to whichever branch happens to iterate first.
    const multiBranch = {
      ...root,
      projects: [
        {
          projectPath: '/repo/app',
          branches: [
            { branchName: 'main', sessions: [session({ primaryBranch: 'feature/x' })] },
            { branchName: 'feature/x', sessions: [session({ primaryBranch: 'feature/x' })] },
          ],
        },
      ],
    } as unknown as RootAnalytics;

    const payload = buildPayload(multiBranch, costIndex, summary, {
      rangeLabel: 'all',
      projectFilter: 'all',
      generatedAt: '2026-06-08T00:00:00Z',
    });

    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0].branch).toBe('feature/x'); // dominant, not first-seen 'main'
  });

  it('uses zero tokens/cost when a session has no cost entry', () => {
    const payload = buildPayload(root, new Map(), { ...summary, totalCostUSD: 0, pricedSessions: 0 }, {
      rangeLabel: 'all',
      projectFilter: 'all',
      generatedAt: '2026-06-08T00:00:00Z',
    });
    expect(payload.sessions[0].costUSD).toBe(0);
    expect(payload.sessions[0].tokens.total).toBe(0);
  });

  it('maps change metrics and cache-read cost onto the record and meta totals', () => {
    const withChanges = {
      ...root,
      projects: [{
        projectPath: '/repo/app',
        branches: [{ branchName: 'main', sessions: [session({ filesChanged: 3, filesWritten: 1, filesEdited: 2, title: 'refactor the cost pipeline' })] }],
      }],
    } as unknown as RootAnalytics;
    const idx: SessionCostIndex = new Map([
      ['s1', { sessionId: 's1', tokens: { input: 100, output: 50, cacheRead: 2000, cacheCreation: 0, total: 2150 }, costUSD: 0.01, cacheReadCostUSD: 0.004, perModel: [], priced: true, hadLog: true }],
    ]);
    const payload = buildPayload(withChanges, idx, summary, { rangeLabel: 'all', projectFilter: 'all', generatedAt: '2026-06-08T00:00:00Z' });
    const s = payload.sessions[0];
    expect(s.filesChanged).toBe(3);
    expect(s.filesWritten).toBe(1);
    expect(s.filesEdited).toBe(2);
    expect(s.cacheReadCostUSD).toBeCloseTo(0.004, 6);
    expect(s.title).toBe('refactor the cost pipeline');
    expect(payload.meta.totals.cacheReadCostUSD).toBeCloseTo(0.004, 6);
  });

  it('passes skillInvocations, agentInvocations, commandInvocations through to session record', () => {
    const skillInvocations = [{ name: 'tech-lead', totalCalls: 3, successCount: 3, failureCount: 0 }];
    const agentInvocations = [{ name: 'Explore', totalCalls: 1, successCount: 1, failureCount: 0 }];
    const commandInvocations = [{ name: 'analytics', totalCalls: 2, successCount: 2, failureCount: 0 }];
    const withStats = {
      ...root,
      projects: [{
        projectPath: '/repo/app',
        branches: [{ branchName: 'main', sessions: [session({ skillInvocations, agentInvocations, commandInvocations })] }],
      }],
    } as unknown as RootAnalytics;
    const payload = buildPayload(withStats, costIndex, summary, {
      rangeLabel: 'all', projectFilter: 'all', generatedAt: '2026-06-08T00:00:00Z',
    });
    const s = payload.sessions[0];
    expect(s.skillInvocations).toEqual(skillInvocations);
    expect(s.agentInvocations).toEqual(agentInvocations);
    expect(s.commandInvocations).toEqual(commandInvocations);
  });

  it('classifies sessionSource from invocation names, defaulting to Pure chat', () => {
    const withCommand = {
      ...root,
      projects: [{
        projectPath: '/repo/app',
        branches: [{ branchName: 'main', sessions: [session({ commandInvocations: [{ name: 'sdlc-light', totalCalls: 1, successCount: 1, failureCount: 0 }] })] }],
      }],
    } as unknown as RootAnalytics;
    const payload = buildPayload(withCommand, costIndex, summary, {
      rangeLabel: 'all', projectFilter: 'all', generatedAt: '2026-06-08T00:00:00Z',
    });
    expect(payload.sessions[0].sessionSource).toBe('CodeMie AI Factory');

    const bare = buildPayload(root, costIndex, summary, {
      rangeLabel: 'all', projectFilter: 'all', generatedAt: '2026-06-08T00:00:00Z',
    });
    expect(bare.sessions[0].sessionSource).toBe('Pure chat');
  });

  it('maps costSeries from the SessionCost when present', () => {
    const idx: SessionCostIndex = new Map([
      ['s1', { sessionId: 's1', tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 250 }, costUSD: 1, perModel: [], priced: true, hadLog: true, costSeries: [{ t: 1, cost: 0.5, tokens: 100 }, { t: 2, cost: 1, tokens: 250 }] }],
    ]);
    const payload = buildPayload(root, idx, summary, { rangeLabel: 'all', projectFilter: 'all', generatedAt: '2026-06-08T00:00:00Z' });
    expect(payload.sessions[0].costSeries).toEqual([{ t: 1, cost: 0.5, tokens: 100 }, { t: 2, cost: 1, tokens: 250 }]);
  });

  it('omits costSeries when the SessionCost has none', () => {
    const payload = buildPayload(root, costIndex, summary, { rangeLabel: 'all', projectFilter: 'all', generatedAt: '2026-06-08T00:00:00Z' });
    expect(payload.sessions[0].costSeries).toBeUndefined();
  });

  it('maps dispatches from the SessionCost when present, omits when absent', () => {
    const dispatches = [{ kind: 'agent' as const, name: 'tech-analyst', start: 1000, durationMs: 150000 }];
    const idx: SessionCostIndex = new Map([
      ['s1', { sessionId: 's1', tokens: emptyTokens(), costUSD: 1, perModel: [], priced: true, hadLog: true, dispatches }],
    ]);
    expect(buildPayload(root, idx, summary, ctxAll).sessions[0].dispatches).toEqual(dispatches);
    expect(buildPayload(root, costIndex, summary, ctxAll).sessions[0].dispatches).toBeUndefined();
  });

  it('threads agentSessionFile onto the record when present, and omits it when absent', () => {
    const withFile = singleBranchRoot([session({ agentSessionFile: '/logs/a.jsonl' })]);
    const ctx = { rangeLabel: 'all', projectFilter: 'all', generatedAt: '2026-06-08T00:00:00Z' };
    expect(buildPayload(withFile, costIndex, summary, ctx).sessions[0].agentSessionFile).toBe('/logs/a.jsonl');

    const noFile = buildPayload(root, costIndex, summary, ctx);
    expect('agentSessionFile' in noFile.sessions[0]).toBe(false);
  });

  it('prefers the cost-resolved agentSessionFile (correlation-file fallback) over an absent session-record path', () => {
    // s.agentSessionFile (SessionAnalytics, native-discovery only) is absent here, but the
    // cost index resolved a log via the correlation-file fallback and priced from it (hadLog:
    // true) — the record must surface THAT path, not omit it, so "File: Not available" never
    // contradicts a session that actually has a priced cost (CR-002).
    const idx: SessionCostIndex = new Map([
      ['s1', { sessionId: 's1', tokens: emptyTokens(), costUSD: 2, perModel: [], priced: true, hadLog: true, agentSessionFile: '/home/.codemie/sessions/s1.json' }],
    ]);
    expect(buildPayload(root, idx, summary, ctxAll).sessions[0].agentSessionFile).toBe('/home/.codemie/sessions/s1.json');
  });

  it('includes userEmail, periodStart, periodEnd in meta when provided in context', () => {
    const payload = buildPayload(root, costIndex, summary, {
      rangeLabel: 'custom',
      projectFilter: 'all',
      generatedAt: '2026-07-21T00:00:00.000Z',
      userEmail: 'alice@example.com',
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-07-21T23:59:59.000Z',
    });
    expect(payload.meta.userEmail).toBe('alice@example.com');
    expect(payload.meta.periodStart).toBe('2026-07-01T00:00:00.000Z');
    expect(payload.meta.periodEnd).toBe('2026-07-21T23:59:59.000Z');
  });

  it('omits userEmail in meta when absent from context', () => {
    const payload = buildPayload(root, costIndex, summary, ctxAll);
    expect(payload.meta.userEmail).toBeUndefined();
  });

  it('derives meta.periodStart from min(startTime) when ctx omits it', () => {
    const sessions = [
      session({ sessionId: 's-early', startTime: T0, duration: HALF_MIN }),
      session({ sessionId: 's-late', startTime: T_PLUS_10M, duration: ONE_MIN }),
    ];
    const payload = buildPayload(singleBranchRoot(sessions), pricedIndex('s-early', 's-late'), summary, ctxAll);
    expect(payload.meta.periodStart).toBe(new Date(T0).toISOString());
  });

  it('derives meta.periodEnd from max(startTime + duration) when ctx omits it', () => {
    const sessions = [
      session({ sessionId: 's-early', startTime: T0, duration: HALF_MIN }),
      session({ sessionId: 's-late', startTime: T_PLUS_10M, duration: ONE_MIN }),
    ];
    const payload = buildPayload(singleBranchRoot(sessions), pricedIndex('s-early', 's-late'), summary, ctxAll);
    expect(payload.meta.periodEnd).toBe(new Date(T_PLUS_10M + ONE_MIN).toISOString());
  });

  it('prefers ctx.periodStart / ctx.periodEnd over derived values (regression guard)', () => {
    const payload = buildPayload(root, costIndex, summary, {
      rangeLabel: 'custom',
      projectFilter: 'all',
      generatedAt: '2026-07-27T00:00:00Z',
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-06-30T00:00:00.000Z',
    });
    expect(payload.meta.periodStart).toBe('2026-01-01T00:00:00.000Z');
    expect(payload.meta.periodEnd).toBe('2026-06-30T00:00:00.000Z');
  });

  it('treats duration=0 as endTime=startTime for periodEnd derivation', () => {
    const sessions = [session({ sessionId: 's-only', startTime: T0, duration: 0 })];
    const payload = buildPayload(singleBranchRoot(sessions), pricedIndex('s-only'), summary, ctxAll);
    expect(payload.meta.periodStart).toBe(new Date(T0).toISOString());
    expect(payload.meta.periodEnd).toBe(new Date(T0).toISOString());
  });

  it('omits meta.periodStart / meta.periodEnd when there are no valid sessions', () => {
    const emptyRoot = {
      totalSessions: 0, totalDuration: 0, totalTurns: 0, totalFileOperations: 0,
      totalLinesAdded: 0, totalLinesRemoved: 0, totalLinesModified: 0, netLinesChanged: 0,
      totalToolCalls: 0, successfulToolCalls: 0, failedToolCalls: 0, toolSuccessRate: 0,
      models: [], tools: [], languages: [], formats: [], projects: [],
    } as unknown as RootAnalytics;
    const payload = buildPayload(emptyRoot, new Map(), summary, ctxAll);
    expect(payload.meta.periodStart).toBeUndefined();
    expect(payload.meta.periodEnd).toBeUndefined();
  });

  it('skips records with non-finite startTime or duration and does not throw', () => {
    // nanDur contributes its finite startTime (NaN duration collapses to 0 → endMs=startTime).
    // infStart is skipped entirely (non-finite startTime fails the guard).
    // good extends maxEndMs past nanDur's startTime.
    const sessions = [
      session({ sessionId: 's-nan-dur', startTime: T0, duration: Number.NaN }),
      session({ sessionId: 's-inf-start', startTime: Number.POSITIVE_INFINITY, duration: ONE_MIN }),
      session({ sessionId: 's-good', startTime: T_PLUS_5M, duration: ONE_MIN }),
    ];
    const payload = buildPayload(
      singleBranchRoot(sessions),
      pricedIndex('s-nan-dur', 's-inf-start', 's-good'),
      summary,
      ctxAll,
    );
    expect(payload.meta.periodStart).toBe(new Date(T0).toISOString());
    expect(payload.meta.periodEnd).toBe(new Date(T_PLUS_5M + ONE_MIN).toISOString());
  });

  it('skips records with startTime <= 0 when computing min/max', () => {
    const sessions = [
      session({ sessionId: 's-zero', startTime: 0, duration: ONE_MIN }),
      session({ sessionId: 's-valid', startTime: T0, duration: ONE_MIN }),
    ];
    const payload = buildPayload(singleBranchRoot(sessions), pricedIndex('s-zero', 's-valid'), summary, ctxAll);
    expect(payload.meta.periodStart).toBe(new Date(T0).toISOString());
    expect(payload.meta.periodEnd).toBe(new Date(T0 + ONE_MIN).toISOString());
  });
});

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
}
const ctxAll = { rangeLabel: 'all', projectFilter: 'all', generatedAt: '2026-06-08T00:00:00Z' };

describe('buildPayload — complete native snapshot projection', () => {
  const tokens = (total: number) => ({ input: total, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, total });
  const snapshot = (): SessionCost => ({
    sessionId: 's1', tokens: tokens(82), costUSD: 8.2, perModel: [{ model: 'fixture-model', tokens: tokens(82), costUSD: 8.2, unpriced: false }],
    priced: true, hadLog: true, capturedAt: T0 + 6_000, observedStart: T0, observedEnd: T0 + 5_000,
    costSource: 'native-estimate', costBasis: 'standard-api-tokens', dispatchesComplete: true,
    rootOwnTokens: tokens(10), rootOwnCostUSD: 1, unlinkedTokens: tokens(2), unlinkedCostUSD: 0.2, unlinkedAgentIds: ['unlinked'],
    costSeries: [{ t: T0, cost: 1, tokens: 10 }, { t: T0 + 5_000, cost: 8.2, tokens: 82 }],
    dispatches: Array.from({ length: 80 }, (_, i): DispatchEvent => ({
      kind: i < 70 ? 'agent' : i < 77 ? 'skill' : 'command', name: i < 70 ? 'worker' : i < 77 ? 'review' : 'run',
      id: `step-${i}`, agentId: i < 70 ? `agent-${i}` : undefined,
      ownerAgentId: i < 50 || i >= 70 ? 's1' : i === 69 ? 'agent-50' : 'agent-0',
      parentId: i < 50 || i >= 70 ? undefined : i === 69 ? 'step-50' : 'step-0',
      depth: i < 50 || i >= 70 ? 1 : i === 69 ? 3 : 2,
      relationshipStatus: 'resolved', start: T0 + i * 10, durationMs: 1,
      acknowledgedAt: T0 + i * 10 + 1, observedEnd: T0 + 4_000, completedAt: T0 + 5_000,
      elapsedMs: 5_000 - i * 10, status: 'completed',
      ...(i < 70 ? { tokens: tokens(1), costUSD: 0.1, inclusiveTokens: tokens(i === 0 ? 21 : i === 50 ? 2 : 1), inclusiveCostUSD: i === 0 ? 2.1 : i === 50 ? 0.2 : 0.1, attributionStatus: 'exact', attributionScope: 'own' } : {}),
    })),
  });
  const payloadFor = (cost = snapshot()) => buildPayload(singleBranchRoot([session({
    agentInvocations: [{ name: 'stale-parent-only', totalCalls: 2, successCount: 2, failureCount: 0 }],
  })]), new Map([['s1', cost]]), summary, ctxAll);

  it('counts all 80 invocations by kind and name without losing hierarchy or double-counting inclusive spend', () => {
    const payload = payloadFor();
    const record = payload.sessions[0];
    expect(record.agentInvocations).toEqual([{ name: 'worker', totalCalls: 70, successCount: 70, failureCount: 0 }]);
    expect(record.skillInvocations[0].totalCalls).toBe(7);
    expect(record.commandInvocations[0].totalCalls).toBe(3);
    expect(record.dispatches).toHaveLength(80);
    expect(record.dispatches![69]).toMatchObject({ id: 'step-69', parentId: 'step-50', ownerAgentId: 'agent-50', depth: 3, relationshipStatus: 'resolved', elapsedMs: 4_310, status: 'completed' });
    expect(record.rootOwnTokens?.total).toBe(10);
    expect(record.unlinkedTokens?.total).toBe(2);
    expect(record.unlinkedAgentIds).toEqual(['unlinked']);
    expect(record.tokens.total).toBe(82);
    expect(record.costUSD).toBe(8.2);
    expect(payload.meta.totals.totalCostUSD).toBe(8.2);
    const topLevel = record.dispatches!.filter((dispatch) => dispatch.kind === 'agent' && !dispatch.parentId);
    expect(record.rootOwnTokens!.total + topLevel.reduce((sum, dispatch) => sum + dispatch.inclusiveTokens!.total, 0) + record.unlinkedTokens!.total).toBe(82);
    expect(record.rootOwnCostUSD! + topLevel.reduce((sum, dispatch) => sum + dispatch.inclusiveCostUSD!, 0) + record.unlinkedCostUSD!).toBeCloseTo(8.2, 12);
    expect(record.perModelCost[0].tokens.total).toBe(record.costSeries!.at(-1)!.tokens);
    expect(record.perModelCost[0].costUSD).toBe(record.costSeries!.at(-1)!.cost);
  });

  it('uses captured activity bounds for the single-session duration and report period', () => {
    const payload = payloadFor();
    expect(payload.sessions[0]).toMatchObject({ capturedAt: T0 + 6_000, observedStart: T0, observedEnd: T0 + 5_000, startTime: T0, durationMs: 5_000, dispatchesComplete: true });
    expect(payload.meta.capturedAt).toBe(T0 + 6_000);
    expect(payload.meta.periodStart).toBe(new Date(T0).toISOString());
    expect(payload.meta.periodEnd).toBe(new Date(T0 + 5_000).toISOString());
    expect(payload.meta.totals.durationMs).toBe(5_000);
  });

  it('projects cost provenance without relabeling source-reported amounts or inventing legacy provenance', () => {
    expect(payloadFor().sessions[0]).toMatchObject({ costSource: 'native-estimate', costBasis: 'standard-api-tokens' });
    const authoritative = { ...snapshot(), costUSD: 12.34, costSource: 'authoritative' as const, costBasis: 'source-reported' as const };
    expect(payloadFor(authoritative).sessions[0]).toMatchObject({ costUSD: 12.34, costSource: 'authoritative', costBasis: 'source-reported' });
    const legacy = buildPayload(root, costIndex, summary, ctxAll).sessions[0];
    expect(legacy.costSource).toBeUndefined();
    expect(legacy.capturedAt).toBeUndefined();
    expect(legacy.rootOwnTokens).toBeUndefined();
  });

  it('keeps aggregate invocation fallbacks for older potentially truncated dispatch lists', () => {
    const legacy = snapshot();
    delete legacy.dispatchesComplete;
    expect(payloadFor(legacy).sessions[0].agentInvocations).toEqual([{ name: 'stale-parent-only', totalCalls: 2, successCount: 2, failureCount: 0 }]);
  });

  it('projects dispatch data without internal transcript or tool bodies', () => {
    const cost = snapshot();
    Object.assign(cost.dispatches![0], { _toolUseId: 'internal-id', messages: [{ body: 'PRIVATE_TRANSCRIPT_BODY' }], input: { prompt: 'PRIVATE_TOOL_BODY' } });
    Object.assign(cost, { parsed: { messages: ['PRIVATE_CAPTURE_BODY'] } });
    const json = JSON.stringify(payloadFor(cost));
    expect(json).not.toContain('PRIVATE_');
    expect(json).not.toContain('_toolUseId');
    expect(JSON.parse(json).sessions[0].dispatches[0].inclusiveTokens.total).toBe(21);
  });
});

/**
 * Copilot CLI reports GitHub's real billing unit (premium requests) alongside tokens, and
 * its older CLI versions record no token telemetry at all. Both are optional and additive,
 * so every other agent's record must be unchanged.
 */
describe('buildPayload — copilot-cli specific fields', () => {
  const copilotRoot = {
    ...root,
    projects: [
      {
        projectPath: '/repo/app',
        branches: [
          {
            branchName: 'main',
            sessions: [
              session({ sessionId: 'cp-priced', agentName: 'copilot-cli' }),
              session({ sessionId: 'cp-partial', agentName: 'copilot-cli' }),
              session({ sessionId: 'cp-unpriced', agentName: 'copilot-cli' }),
              session({ sessionId: 's1', agentName: 'claude' }),
            ],
          },
        ],
      },
    ],
  } as unknown as RootAnalytics;

  const idx: SessionCostIndex = new Map([
    [
      'cp-priced',
      {
        sessionId: 'cp-priced',
        tokens: { input: 381719, output: 173180, cacheRead: 13694976, cacheCreation: 0, total: 14249875 },
        costUSD: 5.5,
        perModel: [],
        priced: true,
        hadLog: true,
        premiumRequests: 3,
        usagePartial: false,
      },
    ],
    [
      'cp-partial',
      {
        sessionId: 'cp-partial',
        tokens: { input: 0, output: 350, cacheRead: 0, cacheCreation: 0, total: 350 },
        costUSD: 0.004,
        perModel: [],
        priced: true,
        hadLog: true,
        usagePartial: true,
      },
    ],
    [
      'cp-unpriced',
      {
        sessionId: 'cp-unpriced',
        tokens: emptyTokens(),
        costUSD: 0,
        perModel: [],
        priced: false,
        hadLog: true,
        usageUnavailableReason: 'No usage data in transcript — this Copilot CLI version recorded no token telemetry',
      },
    ],
    ['s1', { sessionId: 's1', tokens: emptyTokens(), costUSD: 0, perModel: [], priced: true, hadLog: true }],
  ] as never);

  it('carries premium requests onto the session record', () => {
    const payload = buildPayload(copilotRoot, idx, summary, ctxAll);
    const rec = payload.sessions.find((s) => s.sessionId === 'cp-priced')!;

    expect(rec.premiumRequests).toBe(3);
    expect(rec.usagePartial).toBeUndefined(); // false is omitted, not emitted
  });

  it('flags a partially-reconstructed session', () => {
    const payload = buildPayload(copilotRoot, idx, summary, ctxAll);
    const rec = payload.sessions.find((s) => s.sessionId === 'cp-partial')!;

    expect(rec.usagePartial).toBe(true);
  });

  it('carries a reason for sessions with no usage data', () => {
    const payload = buildPayload(copilotRoot, idx, summary, ctxAll);
    const rec = payload.sessions.find((s) => s.sessionId === 'cp-unpriced')!;

    expect(rec.usageUnavailableReason).toMatch(/no token telemetry/i);
    expect(rec.costUSD).toBe(0);
  });

  it('omits all three fields entirely for other agents', () => {
    const payload = buildPayload(copilotRoot, idx, summary, ctxAll);
    const claude = payload.sessions.find((s) => s.sessionId === 's1')!;

    expect(claude.premiumRequests).toBeUndefined();
    expect(claude.usagePartial).toBeUndefined();
    expect(claude.usageUnavailableReason).toBeUndefined();
  });

  it('counts unpriced copilot sessions in the existing AgentCoverage mechanism', () => {
    const payload = buildPayload(copilotRoot, idx, summary, ctxAll);
    const cov = payload.meta.coverage.find((c) => c.agentName === 'copilot-cli')!;

    expect(cov).toEqual({ agentName: 'copilot-cli', total: 3, priced: 2, withLog: 3 });
  });
});
