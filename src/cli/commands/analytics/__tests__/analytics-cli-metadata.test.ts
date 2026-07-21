/**
 * Tests that runAnalytics stamps userEmail, periodStart, periodEnd
 * into the buildPayload context and uses email-aware default paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigLoader } from '../../../../utils/config.js';

// Static import mocks
const aggregateMock = vi.fn();
vi.mock('../aggregator.js', () => ({ AnalyticsAggregator: { aggregate: (...a: unknown[]) => aggregateMock(...a) } }));
vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../formatter.js', () => ({
  AnalyticsFormatter: class { displayRoot = vi.fn(); displayProjects = vi.fn(); },
}));

// Dynamic import mocks (hoisted by vitest)
const enrichCostsMock = vi.fn();
vi.mock('../cost/cost-enricher.js', () => ({ enrichCosts: (...a: unknown[]) => enrichCostsMock(...a), realDeps: {} }));

const buildPayloadMock = vi.fn();
vi.mock('../report/payload-builder.js', () => ({ buildPayload: (...a: unknown[]) => buildPayloadMock(...a) }));

const writeReportMock = vi.fn();
const getDefaultReportPathMock = vi.fn().mockReturnValue('/tmp/report.html');
const getDefaultReportJsonPathMock = vi.fn().mockReturnValue('/tmp/report.report.json');
vi.mock('../report/report-generator.js', () => ({
  generateReport: vi.fn(),
  generateReportJson: vi.fn(),
  getDefaultReportPath: (...a: unknown[]) => getDefaultReportPathMock(...a),
  getDefaultReportJsonPath: (...a: unknown[]) => getDefaultReportJsonPathMock(...a),
  writeReportWithFallback: (...a: unknown[]) => writeReportMock(...a),
}));

const rawSession = { sessionId: 's1' };
const costEntry = { sessionId: 's1', tokens: { total: 10 }, costUSD: 0.01, priced: true };
const enrichResult = {
  index: new Map([['s1', costEntry]]),
  summary: { totalCostUSD: 0.01, pricedSessions: 1, totalSessions: 1, unpricedModels: [] },
};
const analyticsResult = { totalSessions: 1, projects: [] };
const payloadResult = { meta: { totals: { sessions: 1, pricedSessions: 1 } }, sessions: [] };

function mockSource(sessions = [rawSession]) {
  return { load: vi.fn().mockResolvedValue({ rawSessions: sessions, cost: null }) };
}

describe('runAnalytics CLI metadata wiring', () => {
  let configSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    enrichCostsMock.mockResolvedValue(enrichResult);
    aggregateMock.mockReturnValue(analyticsResult);
    buildPayloadMock.mockReturnValue(payloadResult);
    writeReportMock.mockReturnValue({ path: '/tmp/out' });
    getDefaultReportPathMock.mockReturnValue('/tmp/report.html');
    getDefaultReportJsonPathMock.mockReturnValue('/tmp/report.report.json');
    configSpy = vi.spyOn(ConfigLoader, 'loadMultiProviderConfig').mockResolvedValue({ userEmail: 'dev@example.com' } as never);
  });

  it('passes periodStart and periodEnd from --from/--to into buildPayload', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics(
      { report: true, reportFormat: 'json', from: '2026-07-01', to: '2026-07-21' } as never,
      mockSource() as never
    );
    expect(buildPayloadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        periodStart: new Date('2026-07-01').toISOString(),
        periodEnd: new Date('2026-07-21').toISOString(),
      })
    );
  });

  it('passes userEmail from ConfigLoader into buildPayload', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics(
      { report: true, reportFormat: 'json' } as never,
      mockSource() as never
    );
    expect(buildPayloadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userEmail: 'dev@example.com' })
    );
  });

  it('passes userEmail to getDefaultReportPath for the default HTML path', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics(
      { report: true, reportFormat: 'html' } as never,
      mockSource() as never
    );
    expect(getDefaultReportPathMock).toHaveBeenCalledWith(expect.any(String), 'dev@example.com');
  });

  it('passes userEmail to getDefaultReportJsonPath for the default JSON path', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics(
      { report: true, reportFormat: 'json' } as never,
      mockSource() as never
    );
    expect(getDefaultReportJsonPathMock).toHaveBeenCalledWith(expect.any(String), 'dev@example.com');
  });

  it('omits userEmail in buildPayload when ConfigLoader throws', async () => {
    configSpy.mockRejectedValue(new Error('no config'));
    const { runAnalytics } = await import('../index.js');
    await runAnalytics(
      { report: true, reportFormat: 'json' } as never,
      mockSource() as never
    );
    const ctx = buildPayloadMock.mock.calls[0][3];
    expect(ctx.userEmail).toBeUndefined();
  });
});
