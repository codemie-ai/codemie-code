/**
 * Report payload builder unit tests
 */

import { describe, it, expect } from 'vitest';
import { buildPayload } from '../payload-builder.js';
import type { RootAnalytics } from '../../types.js';
import type { SessionCostIndex, CostSummary } from '../../cost/types.js';

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
    const early = session({ sessionId: 's-early', startTime: 1_700_000_000_000, duration: 30_000 });
    const late = session({ sessionId: 's-late', startTime: 1_700_000_600_000, duration: 60_000 });
    const rootTwo = {
      ...root,
      projects: [
        { projectPath: '/repo/app', branches: [{ branchName: 'main', sessions: [early, late] }] },
      ],
    } as unknown as RootAnalytics;
    const costIndexTwo: SessionCostIndex = new Map([
      ['s-early', { sessionId: 's-early', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
      ['s-late', { sessionId: 's-late', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
    ]);
    const payload = buildPayload(rootTwo, costIndexTwo, summary, ctxAll);
    expect(payload.meta.periodStart).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('derives meta.periodEnd from max(startTime + duration) when ctx omits it', () => {
    const early = session({ sessionId: 's-early', startTime: 1_700_000_000_000, duration: 30_000 });
    const late = session({ sessionId: 's-late', startTime: 1_700_000_600_000, duration: 60_000 });
    const rootTwo = {
      ...root,
      projects: [
        { projectPath: '/repo/app', branches: [{ branchName: 'main', sessions: [early, late] }] },
      ],
    } as unknown as RootAnalytics;
    const costIndexTwo: SessionCostIndex = new Map([
      ['s-early', { sessionId: 's-early', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
      ['s-late', { sessionId: 's-late', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
    ]);
    const payload = buildPayload(rootTwo, costIndexTwo, summary, ctxAll);
    expect(payload.meta.periodEnd).toBe(new Date(1_700_000_600_000 + 60_000).toISOString());
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
    const only = session({ sessionId: 's-only', startTime: 1_700_000_000_000, duration: 0 });
    const rootOne = {
      ...root,
      projects: [
        { projectPath: '/repo/app', branches: [{ branchName: 'main', sessions: [only] }] },
      ],
    } as unknown as RootAnalytics;
    const costIndexOne: SessionCostIndex = new Map([
      ['s-only', { sessionId: 's-only', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
    ]);
    const payload = buildPayload(rootOne, costIndexOne, summary, ctxAll);
    expect(payload.meta.periodStart).toBe(new Date(1_700_000_000_000).toISOString());
    expect(payload.meta.periodEnd).toBe(new Date(1_700_000_000_000).toISOString());
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
    // Guard against RangeError from new Date(NaN|Infinity).toISOString() — a single
    // malformed session must not crash report generation for every other session.
    const nanDur = session({ sessionId: 's-nan-dur', startTime: 1_700_000_000_000, duration: Number.NaN });
    const infStart = session({ sessionId: 's-inf-start', startTime: Number.POSITIVE_INFINITY, duration: 60_000 });
    const good = session({ sessionId: 's-good', startTime: 1_700_000_300_000, duration: 60_000 });
    const rootMixed = {
      ...root,
      projects: [
        { projectPath: '/repo/app', branches: [{ branchName: 'main', sessions: [nanDur, infStart, good] }] },
      ],
    } as unknown as RootAnalytics;
    const costIndexMixed: SessionCostIndex = new Map([
      ['s-nan-dur', { sessionId: 's-nan-dur', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
      ['s-inf-start', { sessionId: 's-inf-start', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
      ['s-good', { sessionId: 's-good', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
    ]);
    const payload = buildPayload(rootMixed, costIndexMixed, summary, ctxAll);
    // nanDur contributes its finite startTime (NaN duration collapses to 0 → endMs=startTime).
    // infStart is skipped entirely (non-finite startTime fails the guard).
    // good extends maxEndMs past nanDur's startTime.
    expect(payload.meta.periodStart).toBe(new Date(1_700_000_000_000).toISOString());
    expect(payload.meta.periodEnd).toBe(new Date(1_700_000_300_000 + 60_000).toISOString());
  });

  it('skips records with startTime <= 0 when computing min/max', () => {
    const zero = session({ sessionId: 's-zero', startTime: 0, duration: 60_000 });
    const valid = session({ sessionId: 's-valid', startTime: 1_700_000_000_000, duration: 60_000 });
    const rootMixed = {
      ...root,
      projects: [
        { projectPath: '/repo/app', branches: [{ branchName: 'main', sessions: [zero, valid] }] },
      ],
    } as unknown as RootAnalytics;
    const costIndexMixed: SessionCostIndex = new Map([
      ['s-zero', { sessionId: 's-zero', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
      ['s-valid', { sessionId: 's-valid', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }, costUSD: 0, perModel: [], priced: true, hadLog: true }],
    ]);
    const payload = buildPayload(rootMixed, costIndexMixed, summary, ctxAll);
    expect(payload.meta.periodStart).toBe(new Date(1_700_000_000_000).toISOString());
    expect(payload.meta.periodEnd).toBe(new Date(1_700_000_000_000 + 60_000).toISOString());
  });
});

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
}
const ctxAll = { rangeLabel: 'all', projectFilter: 'all', generatedAt: '2026-06-08T00:00:00Z' };

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
