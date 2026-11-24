import { describe, expect, it } from 'vitest';

import type { MetricDelta } from '../../../../../agents/core/metrics/types.js';
import type { RawSessionData } from '../../data-loader.js';
import type { AnalyticsSource, SourceLoadOptions, SourceResult } from '../../sources/types.js';
import type { CostSummary, SessionCost, SessionCostIndex } from '../../cost/types.js';
import { buildSyncReport } from '../report-builder.js';
import { dailyWindow } from '../window.js';

const EMAIL = 'Dev.User+tag@example.com';

function delta(sessionId: string, i: number): MetricDelta {
  return {
    recordId: `${sessionId}-${i}`,
    sessionId,
    agentSessionId: sessionId,
    timestamp: 1000 + i,
    gitBranch: 'main',
    tools: { Read: 1 },
    toolStatus: { Read: { success: 1, failure: 0 } },
    fileOperations: [{ type: 'edit', path: `f${i}.ts`, linesAdded: 3, linesRemoved: 1 }],
    models: ['claude-sonnet-4-6'],
    syncStatus: 'synced',
    syncAttempts: 0,
  } as MetricDelta;
}

function session(sessionId: string): RawSessionData {
  return {
    sessionId,
    startEvent: {
      recordId: sessionId,
      type: 'session_start',
      timestamp: 1000,
      codeMieSessionId: sessionId,
      agentName: 'claude',
      syncStatus: 'synced',
      data: { provider: 'native', workingDirectory: '/repo', startTime: 1000 },
    },
    endEvent: {
      recordId: `${sessionId}-end`,
      type: 'session_end',
      timestamp: 2000,
      codeMieSessionId: sessionId,
      agentName: 'claude',
      syncStatus: 'synced',
      data: { endTime: 2000, duration: 1000, totalTurns: 2 },
    },
    deltas: [delta(sessionId, 0), delta(sessionId, 1)],
  } as RawSessionData;
}

function cost(sessionId: string): { index: SessionCostIndex; summary: CostSummary } {
  const sessionCost: SessionCost = {
    sessionId,
    tokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, total: 150 },
    costUSD: 0.01,
    perModel: [],
    priced: true,
    hadLog: true,
  };
  const index: SessionCostIndex = new Map([[sessionId, sessionCost]]);
  const summary: CostSummary = {
    totalCostUSD: 0.01,
    pricedSessions: 1,
    totalSessions: 1,
    unpricedModels: [],
    estimatedModels: [],
    localModels: [],
  };
  return { index, summary };
}

/** Stub `AnalyticsSource` that returns `cost` directly so the real cost-enricher is skipped. */
class StubSource implements AnalyticsSource {
  constructor(private readonly result: SourceResult) {}

  async load(_opts: SourceLoadOptions): Promise<SourceResult> {
    return this.result;
  }
}

describe('buildSyncReport', () => {
  it('returns null when the source has zero sessions', async () => {
    const now = new Date('2026-10-29T00:00:00.000Z');
    const window = dailyWindow(now, null, 7);
    const source = new StubSource({ rawSessions: [] });

    const report = await buildSyncReport({ source, window, email: EMAIL, includeExternal: false, now });

    expect(report).toBeNull();
  });

  it('builds a daily report with the lowercased, slugged filename and matching meta fields', async () => {
    const now = new Date('2026-10-29T12:34:56.000Z');
    const window = dailyWindow(now, null, 7);
    const source = new StubSource({ rawSessions: [session('s1')], cost: cost('s1') });

    const report = await buildSyncReport({ source, window, email: EMAIL, includeExternal: false, now });

    expect(report).not.toBeNull();
    // emailSlug is applied to the lowercased email, so sync filenames never carry mixed case
    // even though the shared `emailSlug` helper itself is unchanged.
    expect(report!.fileName).toBe('codemie-analytics-dev-user-tag-example-com-2026-10-29.report.json');

    const payload = JSON.parse(report!.bytes.toString('utf-8'));
    expect(payload.meta.userEmail).toBe(EMAIL);
    expect(payload.meta.generatedAt).toBe(now.toISOString());
    expect(payload.meta.periodStart).toBe(window.from.toISOString());
    expect(payload.meta.periodEnd).toBe(window.to.toISOString());

    // Bytes match the exact `generateReportJson` shape: JSON.stringify(payload, null, 2).
    expect(report!.bytes.toString('utf-8')).toBe(JSON.stringify(payload, null, 2));
  });
});
