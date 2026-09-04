/**
 * Verifies runAnalytics wires the same cost data the console path already shows
 * (costResult.index/summary) into AnalyticsExporter.exportJSON/exportCSV — see CR-003.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const aggregateMock = vi.fn();
vi.mock('../aggregator.js', () => ({ AnalyticsAggregator: { aggregate: (...a: unknown[]) => aggregateMock(...a) } }));
vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../formatter.js', () => ({
  AnalyticsFormatter: class { displayRoot = vi.fn(); displayProjects = vi.fn(); },
}));

const enrichCostsMock = vi.fn();
vi.mock('../cost/cost-enricher.js', () => ({ enrichCosts: (...a: unknown[]) => enrichCostsMock(...a), realDeps: {} }));

const exportJSONMock = vi.fn();
const exportCSVMock = vi.fn();
vi.mock('../exporter.js', () => ({
  AnalyticsExporter: {
    exportJSON: (...a: unknown[]) => exportJSONMock(...a),
    exportCSV: (...a: unknown[]) => exportCSVMock(...a),
    getDefaultOutputPath: () => '/tmp/out',
  },
}));

const rawSession = { sessionId: 's1' };
const costEntry = { sessionId: 's1', tokens: { total: 10 }, costUSD: 0.01, priced: true };
const enrichResult = {
  index: new Map([['s1', costEntry]]),
  summary: { totalCostUSD: 0.01, pricedSessions: 1, totalSessions: 1, unpricedModels: [] },
};
const analyticsResult = { totalSessions: 1, projects: [] };

function mockSource() {
  return { load: vi.fn().mockResolvedValue({ rawSessions: [rawSession], cost: null }) };
}

describe('runAnalytics export wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enrichCostsMock.mockResolvedValue(enrichResult);
    aggregateMock.mockReturnValue(analyticsResult);
  });

  it('passes costIndex and costSummary to exportJSON', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics({ export: 'json' } as never, mockSource() as never);

    expect(exportJSONMock).toHaveBeenCalledWith(
      analyticsResult,
      expect.any(String),
      enrichResult.index,
      enrichResult.summary
    );
  });

  it('passes costIndex to exportCSV', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics({ export: 'csv' } as never, mockSource() as never);

    expect(exportCSVMock).toHaveBeenCalledWith(
      analyticsResult,
      expect.any(String),
      enrichResult.index
    );
  });
});
