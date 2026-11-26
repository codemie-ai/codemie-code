/**
 * Tests that runAnalytics stamps userEmail, periodStart, periodEnd into the buildPayload
 * context and uses email-aware default paths, and that the CLI contract from spec section A
 * (docs/superpowers/tasks/2026-09-26-unify-analytics-cost-command/spec.md) holds:
 *  - `--report`, `--report-format`, `--report-output` are kept as deprecated aliases for
 *    `--export`, `--export [format]`, and `-o/--output` respectively (removed in 1144b247d,
 *    restored for backward compatibility)
 *  - `--export <invalid-format>` (csv included) fails closed: non-zero exitCode, no file written
 *  - a bare `--export` resolves to html
 *  - cost enrichment always runs, even with no export/report flags at all
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigLoader } from '../../../../utils/config.js';

// Static import mocks
const aggregateMock = vi.fn();
vi.mock('../aggregator.js', () => ({ AnalyticsAggregator: { aggregate: (...a: unknown[]) => aggregateMock(...a) } }));
vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const displayRootMock = vi.fn();
const displayProjectsMock = vi.fn();
const displayCostMock = vi.fn();
vi.mock('../formatter.js', () => ({
  AnalyticsFormatter: class {
    displayRoot = displayRootMock;
    displayProjects = displayProjectsMock;
    displayCost = displayCostMock;
  },
}));

const openUrlInBrowserMock = vi.fn();
vi.mock('../../../../utils/browser.js', () => ({ openUrlInBrowser: (...a: unknown[]) => openUrlInBrowserMock(...a) }));

// Dynamic import mocks (hoisted by vitest)
const enrichCostsMock = vi.fn();
vi.mock('../cost/cost-enricher.js', () => ({ enrichCosts: (...a: unknown[]) => enrichCostsMock(...a), realDeps: {} }));

const buildPayloadMock = vi.fn();
vi.mock('../report/payload-builder.js', () => ({ buildPayload: (...a: unknown[]) => buildPayloadMock(...a) }));

const generateReportMock = vi.fn();
const generateReportJsonMock = vi.fn();
const writeReportMock = vi.fn();
const getDefaultReportPathMock = vi.fn().mockReturnValue('/tmp/report.html');
const getDefaultReportJsonPathMock = vi.fn().mockReturnValue('/tmp/report.report.json');
vi.mock('../report/report-generator.js', () => ({
  generateReport: (...a: unknown[]) => generateReportMock(...a),
  generateReportJson: (...a: unknown[]) => generateReportJsonMock(...a),
  getDefaultReportPath: (...a: unknown[]) => getDefaultReportPathMock(...a),
  getDefaultReportJsonPath: (...a: unknown[]) => getDefaultReportJsonPathMock(...a),
  writeReportWithFallback: (...a: unknown[]) => writeReportMock(...a),
}));

const sessionsLoadMock = vi.fn();
vi.mock('../sources/sessions-source.js', () => ({
  SessionsSource: class {
    load = (...a: unknown[]) => sessionsLoadMock(...a);
  },
}));

const rawSession = { sessionId: 's1' };
const costEntry = { sessionId: 's1', tokens: { total: 10 }, costUSD: 0.01, priced: true };
const enrichResult = {
  index: new Map([['s1', costEntry]]),
  summary: { totalCostUSD: 0.01, pricedSessions: 1, totalSessions: 1, unpricedModels: [], estimatedModels: [] },
};
// The report keeps s1: the cost summary displayed is over the kept sessions
const analyticsResult = { totalSessions: 1, projects: [{ branches: [{ sessions: [{ sessionId: 's1' }] }] }] };
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
      { export: 'json', from: '2026-07-01', to: '2026-07-21' } as never,
      mockSource() as never
    );
    expect(buildPayloadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        periodStart: new Date('2026-07-01').toISOString(),
        periodEnd: '2026-07-21T23:59:59.999Z',
      })
    );
  });

  it('passes userEmail from ConfigLoader into buildPayload', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics({ export: 'json' } as never, mockSource() as never);
    expect(buildPayloadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userEmail: 'dev@example.com' })
    );
  });

  it('passes userEmail to getDefaultReportPath for the default HTML path', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics({ export: 'html' } as never, mockSource() as never);
    expect(getDefaultReportPathMock).toHaveBeenCalledWith(expect.any(String), 'dev@example.com');
  });

  it('passes userEmail to getDefaultReportJsonPath for the default JSON path', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics({ export: 'json' } as never, mockSource() as never);
    expect(getDefaultReportJsonPathMock).toHaveBeenCalledWith(expect.any(String), 'dev@example.com');
  });

  it('omits userEmail in buildPayload when ConfigLoader throws', async () => {
    configSpy.mockRejectedValue(new Error('no config'));
    const { runAnalytics } = await import('../index.js');
    await runAnalytics({ export: 'json' } as never, mockSource() as never);
    const ctx = buildPayloadMock.mock.calls[0][3];
    expect(ctx.userEmail).toBeUndefined();
  });

  it('passes both periodStart and periodEnd into buildPayload when --last is used', async () => {
    const before = Date.now();
    const { runAnalytics } = await import('../index.js');
    await runAnalytics({ export: 'json', last: '7d' } as never, mockSource() as never);
    const after = Date.now();
    const ctx = buildPayloadMock.mock.calls[0][3];
    expect(typeof ctx.periodStart).toBe('string');
    expect(typeof ctx.periodEnd).toBe('string');
    const startMs = Date.parse(ctx.periodStart);
    const endMs = Date.parse(ctx.periodEnd);
    expect(endMs).toBeGreaterThanOrEqual(before);
    expect(endMs).toBeLessThanOrEqual(after);
    expect(startMs).toBeLessThan(endMs);
    // 7 days in ms, allow ±5s window for parseDuration + Date.now drift
    const diff = endMs - startMs;
    expect(diff).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 5000);
    expect(diff).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 5000);
  });

  it('invokes buildPayload for --session with no --from/--to', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics(
      { export: 'json', session: 'abc-123' } as never,
      mockSource() as never
    );
    expect(buildPayloadMock).toHaveBeenCalledTimes(1);
    const ctx = buildPayloadMock.mock.calls[0][3];
    expect(ctx.periodStart).toBeUndefined();
    expect(ctx.periodEnd).toBeUndefined();
    // Fallback is buildPayload's responsibility (covered in payload-builder.test.ts).
  });

  it('invokes buildPayload for --project + --branch with no --from/--to', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics(
      { export: 'json', project: 'my-proj', branch: 'feature/x' } as never,
      mockSource() as never
    );
    expect(buildPayloadMock).toHaveBeenCalledTimes(1);
    const ctx = buildPayloadMock.mock.calls[0][3];
    expect(ctx.periodStart).toBeUndefined();
    expect(ctx.periodEnd).toBeUndefined();
  });

  it('invokes buildPayload for a bare report (no filters at all)', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics({ export: 'json' } as never, mockSource() as never);
    expect(buildPayloadMock).toHaveBeenCalledTimes(1);
    const ctx = buildPayloadMock.mock.calls[0][3];
    expect(ctx.periodStart).toBeUndefined();
    expect(ctx.periodEnd).toBeUndefined();
  });
});

describe('analytics CLI contract (unify-analytics-cost-command T6)', () => {
  it.each([['--report', []], ['--report-format', ['json']], ['--report-output', ['/tmp/x.html']]])(
    'removed %s fails naming --export / -o and runs nothing',
    async (flag, rest) => {
      const { createAnalyticsCommand } = await import('../index.js');
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      process.exitCode = undefined;
      try {
        await createAnalyticsCommand().parseAsync([flag, ...rest], { from: 'user' });
        expect(process.exitCode).toBe(1);
        const out = err.mock.calls.map((c) => String(c[0])).join('');
        expect(out).toMatch(/--export|-o/);
        expect(sessionsLoadMock).not.toHaveBeenCalled();
      } finally {
        err.mockRestore();
        process.exitCode = undefined;
      }
    }
  );

  it('--export csv sets a non-zero exitCode and writes no file', async () => {
    const { runAnalytics } = await import('../index.js');
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runAnalytics({ export: 'csv' } as never, mockSourceForContract() as never);
      expect(process.exitCode).toBe(1);
      expect(generateReportMock).not.toHaveBeenCalled();
      expect(generateReportJsonMock).not.toHaveBeenCalled();
      expect(writeReportMock).not.toHaveBeenCalled();
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('a bare --export resolves to html', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics({ export: true } as never, mockSourceForContract() as never);
    expect(getDefaultReportPathMock).toHaveBeenCalled();
    expect(getDefaultReportJsonPathMock).not.toHaveBeenCalled();
  });

  it('runAnalytics with a stub source and no export flags still calls enrichCosts', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics({} as never, mockSourceForContract() as never);
    expect(enrichCostsMock).toHaveBeenCalled();
  });

  it('CR-005 an invalid --export short-circuits before loading sources, even with zero sessions', async () => {
    vi.clearAllMocks();
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const emptySource = mockSource([]);
    try {
      const { runAnalytics } = await import('../index.js');
      await runAnalytics({ export: 'csv' } as never, emptySource as never);
      expect(process.exitCode).toBe(1);
      expect(emptySource.load).not.toHaveBeenCalled();
      expect(enrichCostsMock).not.toHaveBeenCalled();
      expect(displayCostMock).not.toHaveBeenCalled();
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('CR-009 displayCost receives the enrichCosts summary over the kept sessions for a bare run (no export/open)', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics({} as never, mockSourceForContract() as never);
    expect(displayCostMock).toHaveBeenCalledWith(enrichResult.summary);
  });

  it('CR-009 displayCost receives the enrichCosts summary over the kept sessions for --export json', async () => {
    const { runAnalytics } = await import('../index.js');
    await runAnalytics({ export: 'json' } as never, mockSourceForContract() as never);
    expect(displayCostMock).toHaveBeenCalledWith(enrichResult.summary);
  });

  function mockSourceForContract() {
    vi.clearAllMocks();
    enrichCostsMock.mockResolvedValue(enrichResult);
    aggregateMock.mockReturnValue(analyticsResult);
    buildPayloadMock.mockReturnValue(payloadResult);
    writeReportMock.mockReturnValue({ path: '/tmp/out' });
    getDefaultReportPathMock.mockReturnValue('/tmp/report.html');
    getDefaultReportJsonPathMock.mockReturnValue('/tmp/report.report.json');
    vi.spyOn(ConfigLoader, 'loadMultiProviderConfig').mockResolvedValue({ userEmail: 'dev@example.com' } as never);
    return mockSource();
  }
});

describe('--open implies html (unify-analytics-cost-command CR-006)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enrichCostsMock.mockResolvedValue(enrichResult);
    aggregateMock.mockReturnValue(analyticsResult);
    buildPayloadMock.mockReturnValue(payloadResult);
    getDefaultReportPathMock.mockReturnValue('/tmp/report.html');
    getDefaultReportJsonPathMock.mockReturnValue('/tmp/report.report.json');
    vi.spyOn(ConfigLoader, 'loadMultiProviderConfig').mockResolvedValue({ userEmail: 'dev@example.com' } as never);
  });

  it('runAnalytics({ open: true }) writes and opens the HTML report', async () => {
    // Let writeReportWithFallback call through to its write() argument (as the real
    // implementation does) so generateReport is actually invoked, not just scheduled.
    writeReportMock.mockImplementation((write: (p: string) => void, path: string) => {
      write(path);
      return { path };
    });
    const { runAnalytics } = await import('../index.js');
    await runAnalytics({ open: true } as never, mockSource() as never);
    expect(generateReportMock).toHaveBeenCalled();
    expect(openUrlInBrowserMock).toHaveBeenCalledWith('/tmp/report.html');
  });

  it('runAnalytics({ open: true, export: "json" }) does not open a browser and prints the no-HTML notice', async () => {
    writeReportMock.mockReturnValue({ path: '/tmp/report.report.json' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { runAnalytics } = await import('../index.js');
      await runAnalytics({ open: true, export: 'json' } as never, mockSource() as never);
      expect(openUrlInBrowserMock).not.toHaveBeenCalled();
      const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(printed).toContain('--open ignored: no HTML produced');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('-o without --export/--open infers the format from the path (unify-analytics-cost-command CR-007)', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    enrichCostsMock.mockResolvedValue(enrichResult);
    aggregateMock.mockReturnValue(analyticsResult);
    buildPayloadMock.mockReturnValue(payloadResult);
    vi.spyOn(ConfigLoader, 'loadMultiProviderConfig').mockResolvedValue({ userEmail: 'dev@example.com' } as never);
    tmpDir = mkdtempSync(join(tmpdir(), 'analytics-cr007-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('-o ending in .json infers --export json', async () => {
    const { runAnalytics } = await import('../index.js');
    const outputPath = join(tmpDir, 'report.json');
    await runAnalytics({ output: outputPath } as never, mockSource() as never);
    expect(generateReportJsonMock).toHaveBeenCalledWith(payloadResult, outputPath);
    expect(generateReportMock).not.toHaveBeenCalled();
  });

  it('-o not ending in .json (a plain file, or a directory target) infers --export html', async () => {
    const { runAnalytics } = await import('../index.js');
    const outputPath = join(tmpDir, 'report.html');
    await runAnalytics({ output: outputPath } as never, mockSource() as never);
    expect(generateReportMock).toHaveBeenCalledWith(payloadResult, outputPath);
    expect(generateReportJsonMock).not.toHaveBeenCalled();
  });

  it('-o naming a directory (trailing separator) infers --export html', async () => {
    const { runAnalytics } = await import('../index.js');
    const outputDir = `${tmpDir}/`;
    await runAnalytics({ output: outputDir } as never, mockSource() as never);
    expect(generateReportMock).toHaveBeenCalled();
    expect(generateReportJsonMock).not.toHaveBeenCalled();
  });
});


describe('analytics --include-external [policy] and filter validation (proxy-analytics-cli-redesign task 17)', () => {
  let err: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  const stderr = (): string => err.mock.calls.map((c) => String(c[0])).join('');

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    sessionsLoadMock.mockResolvedValue({ rawSessions: [], cost: null });
    err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  async function run(args: string[]): Promise<void> {
    const { createAnalyticsCommand } = await import('../index.js');
    await createAnalyticsCommand().parseAsync(args, { from: 'user' });
  }

  it.each([
    ['never', false],
    ['always', true],
  ])('--include-external %s maps through includeExternalFor', async (policy, expected) => {
    await run(['--include-external', policy]);
    expect(sessionsLoadMock).toHaveBeenCalledWith(expect.objectContaining({ includeExternal: expected }));
    expect(stderr()).not.toContain('Deprecated');
    expect(process.exitCode).toBeUndefined();
  });

  it('--include-external windows follows the platform', async () => {
    await run(['--include-external', 'windows']);
    expect(sessionsLoadMock).toHaveBeenCalledWith(
      expect.objectContaining({ includeExternal: process.platform === 'win32' })
    );
  });

  it('bare --include-external means always and prints one deprecation notice', async () => {
    await run(['--include-external']);
    expect(sessionsLoadMock).toHaveBeenCalledWith(expect.objectContaining({ includeExternal: true }));
    const lines = stderr().split('\n').filter((l) => l.includes('Deprecated'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('codemie analytics --include-external');
  });

  it.each(['otel', 'sync'])('--include-external %s (a subcommand name) is an error, not a policy', async (name) => {
    await run(['--include-external', name]);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toContain(name);
    expect(stderr()).toMatch(/windows, always, or never/);
    expect(sessionsLoadMock).not.toHaveBeenCalled();
  });

  it('an unknown policy value is an error', async () => {
    await run(['--include-external', 'sometimes']);
    expect(process.exitCode).toBe(1);
    expect(stderr()).toMatch(/windows, always, or never/);
    expect(sessionsLoadMock).not.toHaveBeenCalled();
  });

  it.each([
    [['--from', '10/25/2026'], 'YYYY-MM-DD'],
    [['--to', 'tomorrow'], 'YYYY-MM-DD'],
    [['--last', '7x'], '7d'],
  ])('invalid %j sets exitCode 1 and states the accepted format', async (args, accepted) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await run(args as string[]);
    const out = stderr() + log.mock.calls.map((c) => String(c[0])).join('') +
      (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('');
    expect(process.exitCode).toBe(1);
    expect(out).toContain(accepted);
    expect(exit).not.toHaveBeenCalled();
    expect(sessionsLoadMock).not.toHaveBeenCalled();
  });
});
