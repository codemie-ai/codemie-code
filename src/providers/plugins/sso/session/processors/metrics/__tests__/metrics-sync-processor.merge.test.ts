/**
 * MetricsSyncProcessor's final rewrite merges instead of overwriting: a delta appended while the
 * request is in flight stays pending, whatever the server answered.
 *
 * Seams: `MetricsSyncProcessor.process` + `MetricsWriter.appendDeltas` over a temp sessions dir;
 * the network boundary is `fetch`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { onFakeClock } from '../../../../../../../../tests/helpers/fake-clock.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), isDebugMode: () => false },
}));

const { MetricsSyncProcessor } = await import('../metrics-sync-processor.js');
const { MetricsWriter } = await import('../MetricsWriter.js');
const { processStartedAt } = await import('@/utils/processes.js');

const SESSION_ID = '00000000-0000-4000-8000-0000000000ee';
const START = Date.parse('2026-10-01T10:00:00Z');

let home: string;
let sessionsDir: string;
const previousHome = process.env.CODEMIE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'metrics-sync-merge-'));
  process.env.CODEMIE_HOME = home;
  sessionsDir = join(home, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${SESSION_ID}.json`), JSON.stringify({
    sessionId: SESSION_ID,
    agentName: 'claude',
    provider: 'ai-run-sso',
    startTime: START,
    workingDirectory: home,
    status: 'active',
    activeDurationMs: 0,
    gitBranch: 'main',
    correlation: { status: 'matched', retryCount: 0, agentSessionId: 'claude-native' },
  }));
  writeFileSync(join(sessionsDir, `${SESSION_ID}_metrics.jsonl`), `${JSON.stringify({
    recordId: 'D1',
    sessionId: SESSION_ID,
    agentSessionId: 'claude-native',
    timestamp: START + 1000,
    gitBranch: 'main',
    tools: { Read: 1 },
    toolStatus: { Read: { success: 1, failure: 0 } },
    fileOperations: [],
    syncStatus: 'pending',
    syncAttempts: 0,
  })}\n`);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function statuses(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(join(sessionsDir, `${SESSION_ID}_metrics.jsonl`), 'utf-8').trim().split('\n')
      .map((line) => JSON.parse(line) as { recordId: string; syncStatus: string })
      .map((d) => [d.recordId, d.syncStatus])
  );
}

async function syncWhileAppending(answer: () => Response): Promise<void> {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    // D2 arrives (a hook appends it) while the request to the server is in flight
    await new MetricsWriter(SESSION_ID).appendDeltas(
      [{ recordId: 'D2', sessionId: SESSION_ID, agentSessionId: 'claude-native', timestamp: START + 2000, gitBranch: 'main', tools: {} }],
      { startTime: START }
    );
    return answer();
  });
  await new MetricsSyncProcessor().process(
    { sessionId: SESSION_ID, agentName: 'claude' } as never,
    { sessionId: SESSION_ID, apiBaseUrl: 'http://127.0.0.1:4999', cookies: 'session=abc', clientType: 'codemie-claude', version: '0.0.0', dryRun: false } as never,
  );
}

describe('MetricsSyncProcessor final rewrite', () => {
  it('marks what it sent synced and keeps a delta appended during the request pending', async () => {
    await syncWhileAppending(() => new Response(JSON.stringify({ success: true, message: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } }));

    expect(statuses()).toEqual({ D1: 'synced', D2: 'pending' });
  });

  it('marks what it sent failed and keeps a delta appended during the request pending', async () => {
    await syncWhileAppending(() => new Response(JSON.stringify({ message: 'bad request' }), { status: 400, headers: { 'content-type': 'application/json' } }));

    expect(statuses()).toEqual({ D1: 'failed', D2: 'pending' });
  });
});

const accepted = () => new Response(JSON.stringify({ success: true, message: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
const context = { sessionId: SESSION_ID, apiBaseUrl: 'http://127.0.0.1:4999', cookies: 'session=abc', clientType: 'codemie-claude', version: '0.0.0', dryRun: false } as never;

describe('MetricsSyncProcessor after the server accepted the batch', () => {
  it('a metrics lock held past the wait: no throw, the pass reported not persisted, the deltas still pending', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    // Another live process holds the metrics lock throughout
    writeFileSync(join(sessionsDir, `${SESSION_ID}.metrics.lock`), JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));

    const result = await onFakeClock(() => new MetricsSyncProcessor().process({ sessionId: SESSION_ID, agentName: 'claude' } as never, context));

    expect(result).toMatchObject({ success: true, metadata: { persisted: false } });
    expect(statuses()).toEqual({ D1: 'pending' });
  });

  it('the live file removed during the request: not re-created, the totals of what was sent returned', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      rmSync(join(sessionsDir, `${SESSION_ID}_metrics.jsonl`));
      return accepted();
    });

    const result = await new MetricsSyncProcessor().process({ sessionId: SESSION_ID, agentName: 'claude' } as never, context);

    expect(existsSync(join(sessionsDir, `${SESSION_ID}_metrics.jsonl`))).toBe(false);
    expect(result.metadata?.syncUpdates?.metrics).toMatchObject({ processedRecordIds: ['D1'], totalSynced: 1, totalFailed: 0, totalDeltas: 1 });
  });
});

describe('MetricsSyncProcessor over a torn line', () => {
  it('sends the good deltas around a torn line, warns naming the file and the count, and rewrites the file without it', async () => {
    const metricsFile = join(sessionsDir, `${SESSION_ID}_metrics.jsonl`);
    const d2 = { recordId: 'D2', sessionId: SESSION_ID, agentSessionId: 'claude-native', timestamp: START + 2000, gitBranch: 'main', tools: {}, fileOperations: [], syncStatus: 'pending', syncAttempts: 0 };
    writeFileSync(metricsFile, `${readFileSync(metricsFile, 'utf-8')}{"recordId":"torn\n${JSON.stringify(d2)}\n`);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => accepted());
    const { logger } = await import('@/utils/logger.js');
    vi.mocked(logger.warn).mockClear();

    const result = await new MetricsSyncProcessor().process({ sessionId: SESSION_ID, agentName: 'claude' } as never, context);

    expect(result.metadata?.syncUpdates?.metrics).toMatchObject({ processedRecordIds: ['D1', 'D2'], totalSynced: 2 });
    expect(readFileSync(metricsFile, 'utf-8').trim().split('\n')).toHaveLength(2);
    expect(statuses()).toEqual({ D1: 'synced', D2: 'synced' });
    expect(vi.mocked(logger.warn).mock.calls.map(([line]) => String(line)))
      .toContain(`[metrics-sync] Skipped 1 corrupted JSONL lines in ${metricsFile}`);
  });
});
