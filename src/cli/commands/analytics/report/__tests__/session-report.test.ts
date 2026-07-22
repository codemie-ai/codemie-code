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
  emailSlug: (email: string) => email.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''),
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

  it('writes nothing when a non-empty session aggregates to zero analytics data', async () => {
    loadMock.mockResolvedValue({ rawSessions: [{ sessionId: 's1' }] });
    enrichCostsMock.mockResolvedValue({
      index: new Map([['s1', { sessionId: 's1', tokens: { total: 0 } }]]),
      summary: { totalCostUSD: 0, pricedSessions: 0, totalSessions: 0 },
    });
    aggregateMock.mockReturnValue({ totalSessions: 0, projects: [] });

    const { generateSessionReport } = await import('../session-report.js');
    const res = await generateSessionReport({ sessionId: 's1', outputPath: '/tmp/zero.json' });

    expect(generateReportJsonMock).not.toHaveBeenCalled();
    expect(res).toEqual({ written: null, sessions: 0 });
  });

  it('passes userEmail to buildPayload context when provided', async () => {
    loadMock.mockResolvedValue({ rawSessions: [{ sessionId: 's1' }] });
    enrichCostsMock.mockResolvedValue({
      index: new Map([['s1', { sessionId: 's1', tokens: { total: 10 } }]]),
      summary: { totalCostUSD: 0, pricedSessions: 1, totalSessions: 1 },
    });
    aggregateMock.mockReturnValue({ totalSessions: 1, projects: [] });
    buildPayloadMock.mockReturnValue({ meta: { totals: { sessions: 1 } }, sessions: [] });

    const { generateSessionReport } = await import('../session-report.js');
    await generateSessionReport({ sessionId: 's1', outputPath: '/tmp/out.json', userEmail: 'bob@example.com' });

    expect(buildPayloadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userEmail: 'bob@example.com' })
    );
  });

  it('derives default output path with email slug when outputPath omitted and email provided', async () => {
    loadMock.mockResolvedValue({ rawSessions: [{ sessionId: 'abc-123' }] });
    enrichCostsMock.mockResolvedValue({
      index: new Map([['abc-123', { sessionId: 'abc-123', tokens: { total: 10 } }]]),
      summary: { totalCostUSD: 0, pricedSessions: 1, totalSessions: 1 },
    });
    aggregateMock.mockReturnValue({ totalSessions: 1, projects: [] });
    buildPayloadMock.mockReturnValue({ meta: { totals: { sessions: 1 } }, sessions: [] });

    const { generateSessionReport } = await import('../session-report.js');
    await generateSessionReport({ sessionId: 'abc-123', userEmail: 'bob@example.com' });

    // The path passed to generateReportJson should contain the email slug and sessionId
    const writtenPath: string = generateReportJsonMock.mock.calls[0][1];
    expect(writtenPath).toContain('codemie-analytics-bob-example-com-abc-123.json');
  });

  it('passes periodStart/periodEnd to buildPayload when session has start/end events', async () => {
    loadMock.mockResolvedValue({
      rawSessions: [{
        sessionId: 's1',
        startEvent: { data: { startTime: 1753056000000 } },
        endEvent: { data: { endTime: 1753059600000 } },
      }],
    });
    enrichCostsMock.mockResolvedValue({
      index: new Map([['s1', { sessionId: 's1', tokens: { total: 10 } }]]),
      summary: { totalCostUSD: 0, pricedSessions: 1, totalSessions: 1 },
    });
    aggregateMock.mockReturnValue({ totalSessions: 1, projects: [] });
    buildPayloadMock.mockReturnValue({ meta: { totals: { sessions: 1 } }, sessions: [] });

    const { generateSessionReport } = await import('../session-report.js');
    await generateSessionReport({ sessionId: 's1', outputPath: '/tmp/out.json' });

    expect(buildPayloadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        periodStart: new Date(1753056000000).toISOString(),
        periodEnd: new Date(1753059600000).toISOString(),
      })
    );
  });
});
