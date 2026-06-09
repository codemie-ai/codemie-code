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
    totalToolCalls: 4,
    successfulToolCalls: 4,
    failedToolCalls: 0,
    toolSuccessRate: 100,
    models: [{ model: 'claude-sonnet-4-5', calls: 5, percentage: 100 }],
    tools: [],
    files: [],
    languages: [{ language: 'typescript', filesCreated: 1, filesModified: 0, linesAdded: 12, linesRemoved: 0, percentage: 100 }],
    formats: [],
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
});
