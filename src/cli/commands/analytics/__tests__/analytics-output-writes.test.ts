/**
 * CR-010: explicit `-o, --output <path>` writes were only exercised by the `agent`-project
 * T1 test (tests/integration/agent-analytics-report-shape.test.ts), which `npm run ci` never
 * runs. This file drives runAnalytics through real filesystem writes for both -o shapes the
 * CLI project must cover:
 *  - a directory target (`--export both -o <tmp>/nested/dir/`) -> both default-named files land
 *    on disk under it.
 *  - an explicit file target (`--export json -o <tmp>/x.json`) -> generateReportJson writes
 *    exactly that path, and writeReportWithFallback (the relocating default-path helper) is
 *    never invoked for an explicit -o.
 *
 * aggregator/cost-enricher/payload-builder are mocked (as in analytics-cli-metadata.test.ts) to
 * keep the ReportPayload deterministic; report-generator.js and output-target.js are the REAL
 * modules so the write actually reaches disk.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigLoader } from '../../../../utils/config.js';

const aggregateMock = vi.fn();
vi.mock('../aggregator.js', () => ({ AnalyticsAggregator: { aggregate: (...a: unknown[]) => aggregateMock(...a) } }));
vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../formatter.js', () => ({
  AnalyticsFormatter: class { displayRoot = vi.fn(); displayProjects = vi.fn(); displayCost = vi.fn(); },
}));

const enrichCostsMock = vi.fn();
vi.mock('../cost/cost-enricher.js', () => ({ enrichCosts: (...a: unknown[]) => enrichCostsMock(...a), realDeps: {} }));

const buildPayloadMock = vi.fn();
vi.mock('../report/payload-builder.js', () => ({ buildPayload: (...a: unknown[]) => buildPayloadMock(...a) }));

// report-generator.js is left REAL (via importOriginal) so files actually land on disk;
// generateReportJson/writeReportWithFallback are wrapped in trackable spies that still call
// through to the real implementation.
const generateReportJsonSpy = vi.fn();
const writeReportWithFallbackSpy = vi.fn();
vi.mock('../report/report-generator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../report/report-generator.js')>();
  generateReportJsonSpy.mockImplementation(actual.generateReportJson);
  writeReportWithFallbackSpy.mockImplementation(actual.writeReportWithFallback);
  return {
    ...actual,
    generateReportJson: (...a: Parameters<typeof actual.generateReportJson>) => generateReportJsonSpy(...a),
    writeReportWithFallback: (...a: Parameters<typeof actual.writeReportWithFallback>) => writeReportWithFallbackSpy(...a),
  };
});

const rawSession = { sessionId: 's1' };
const enrichResult = {
  index: new Map([['s1', { sessionId: 's1', tokens: { total: 10 }, costUSD: 0.01, priced: true }]]),
  summary: { totalCostUSD: 0.01, pricedSessions: 1, totalSessions: 1, unpricedModels: [], estimatedModels: [] },
};
const analyticsResult = { totalSessions: 1, projects: [] };
const payloadResult = {
  meta: { agents: ['claude'], unpricedModels: [], estimatedModels: [], totals: { sessions: 1, pricedSessions: 1 } },
  sessions: [],
};

function mockSource() {
  return { load: vi.fn().mockResolvedValue({ rawSessions: [rawSession], cost: null }) };
}

describe('runAnalytics explicit -o writes (unify-analytics-cost-command CR-010)', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    enrichCostsMock.mockResolvedValue(enrichResult);
    aggregateMock.mockReturnValue(analyticsResult);
    buildPayloadMock.mockReturnValue(payloadResult as never);
    vi.spyOn(ConfigLoader, 'loadMultiProviderConfig').mockResolvedValue({ userEmail: 'dev@example.com' } as never);
    tmpDir = mkdtempSync(join(tmpdir(), 'analytics-cr010-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('{ export: "both", output: "<tmp>/nested/dir/" } writes both default-named files', async () => {
    const { runAnalytics } = await import('../index.js');
    const { getDefaultReportPath, getDefaultReportJsonPath } = await import('../report/report-generator.js');
    const resolvedDir = join(tmpDir, 'nested', 'dir');
    const outputDir = `${resolvedDir}/`;

    await runAnalytics({ export: 'both', output: outputDir } as never, mockSource() as never);

    expect(existsSync(getDefaultReportPath(resolvedDir, 'dev@example.com'))).toBe(true);
    expect(existsSync(getDefaultReportJsonPath(resolvedDir, 'dev@example.com'))).toBe(true);
  });

  it('{ export: "json", output: "<tmp>/x.json" } writes that exact path, bypassing the default-path fallback', async () => {
    const { runAnalytics } = await import('../index.js');
    const outputPath = join(tmpDir, 'x.json');

    await runAnalytics({ export: 'json', output: outputPath } as never, mockSource() as never);

    expect(generateReportJsonSpy).toHaveBeenCalledWith(payloadResult, outputPath);
    expect(writeReportWithFallbackSpy).not.toHaveBeenCalled();
    expect(existsSync(outputPath)).toBe(true);
  });
});
