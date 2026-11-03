/**
 * MetricsSyncProcessor when the caller's abort stops a metric request in flight: the branch's
 * deltas stay pending for the next run, with no attempt counted and no error.
 *
 * Seams: `MetricsSyncProcessor.process` over a temp sessions dir; the network boundary is `fetch`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), isDebugMode: () => false },
}));

const { MetricsSyncProcessor } = await import('../metrics-sync-processor.js');

const SESSION_ID = '00000000-0000-4000-8000-0000000000cc';

let home: string;
let sessionsDir: string;
const previousHome = process.env.CODEMIE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'metrics-sync-stop-'));
  process.env.CODEMIE_HOME = home;
  sessionsDir = join(home, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('MetricsSyncProcessor', () => {
  it('keeps the deltas of a metric request stopped by the abort mid-flight pending: no attempt, no error', async () => {
    writeFileSync(join(sessionsDir, `${SESSION_ID}.json`), JSON.stringify({
      sessionId: SESSION_ID,
      agentName: 'claude',
      provider: 'ai-run-sso',
      startTime: Date.parse('2026-10-01T10:00:00Z'),
      workingDirectory: home,
      status: 'active',
      activeDurationMs: 0,
      gitBranch: 'main',
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'claude-native' },
    }));
    writeFileSync(join(sessionsDir, `${SESSION_ID}_metrics.jsonl`), `${JSON.stringify({
      recordId: 'rec-1',
      sessionId: SESSION_ID,
      agentSessionId: 'claude-native',
      timestamp: Date.parse('2026-10-01T10:01:00Z'),
      gitBranch: 'main',
      tools: { Read: 1 },
      toolStatus: { Read: { success: 1, failure: 0 } },
      fileOperations: [],
      syncStatus: 'pending',
      syncAttempts: 0,
    })}\n`);
    const controller = new AbortController();
    // The request is in flight when the caller aborts; only that abort ends it
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      (init as RequestInit).signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      controller.abort();
    }));

    const result = await new MetricsSyncProcessor().process(
      { sessionId: SESSION_ID, agentName: 'claude' } as never,
      {
        sessionId: SESSION_ID,
        apiBaseUrl: 'http://127.0.0.1:4999',
        cookies: 'session=abc',
        clientType: 'codemie-claude',
        version: '0.0.0',
        dryRun: false,
        abortSignal: controller.signal,
      } as never,
    );

    expect(result.message).toMatch(/Sync deferred/);
    const [delta] = readFileSync(join(sessionsDir, `${SESSION_ID}_metrics.jsonl`), 'utf-8').trim().split('\n')
      .map((line) => JSON.parse(line) as { syncStatus: string; syncAttempts: number; syncError?: string });
    expect(delta).toMatchObject({ syncStatus: 'pending', syncAttempts: 0 });
    expect(delta.syncError).toBeUndefined();
  });
});
