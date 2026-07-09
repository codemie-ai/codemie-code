import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadMock = vi.fn();
vi.mock('../../sources/sessions-source.js', () => ({
  SessionsSource: class {
    load = loadMock;
  },
}));
const enrichCostsMock = vi.fn();
vi.mock('../../cost/cost-enricher.js', () => ({ enrichCosts: (...a: unknown[]) => enrichCostsMock(...a) }));
const aggregateMock = vi.fn();
vi.mock('../../aggregator.js', () => ({ AnalyticsAggregator: { aggregate: (...a: unknown[]) => aggregateMock(...a) } }));
const buildPayloadMock = vi.fn();
vi.mock('../payload-builder.js', () => ({ buildPayload: (...a: unknown[]) => buildPayloadMock(...a) }));
const generateReportJsonMock = vi.fn();
vi.mock('../report-generator.js', () => ({
  generateReportJson: (...a: unknown[]) => generateReportJsonMock(...a),
  // Real fallback semantics: just invoke the writer with the preferred path.
  writeReportWithFallback: (write: (p: string) => void, p: string) => {
    write(p);
    return { path: p };
  },
}));

describe('generateSessionReport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a JSON report for a session that has data', async () => {
    loadMock.mockResolvedValue({ rawSessions: [{ sessionId: 's1' }] });
    enrichCostsMock.mockResolvedValue({
      index: new Map([['s1', { sessionId: 's1', tokens: { total: 10 } }]]),
      summary: { totalCostUSD: 0, pricedSessions: 1, totalSessions: 1 },
    });
    aggregateMock.mockReturnValue({ totalSessions: 1, projects: [] });
    buildPayloadMock.mockReturnValue({ meta: { totals: { sessions: 1 } }, sessions: [{ sessionId: 's1' }] });

    const { generateSessionReport } = await import('../session-report.js');
    const res = await generateSessionReport({ sessionId: 's1', outputPath: '/tmp/out.json' });

    expect(loadMock).toHaveBeenCalledWith({ filter: { sessionId: 's1' }, scanNative: true });
    expect(generateReportJsonMock).toHaveBeenCalledWith(expect.anything(), '/tmp/out.json');
    expect(res).toEqual({ written: '/tmp/out.json', sessions: 1 });
  });

  it('writes nothing when the session has no data', async () => {
    loadMock.mockResolvedValue({ rawSessions: [] });
    const { generateSessionReport } = await import('../session-report.js');
    const res = await generateSessionReport({ sessionId: 'missing', outputPath: '/tmp/none.json' });
    expect(generateReportJsonMock).not.toHaveBeenCalled();
    expect(res).toEqual({ written: null, sessions: 0 });
  });
});
