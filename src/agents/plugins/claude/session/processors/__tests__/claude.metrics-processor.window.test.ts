/**
 * The run window keeps a record to its own slice of the transcript: [startTime, upper bound).
 *
 * Seam: MetricsProcessor over the real MetricsWriter and run window on a temp sessions directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ParsedSession } from '../../../../../core/session/BaseSessionAdapter.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), isDebugMode: () => false },
}));

const { MetricsProcessor } = await import('../claude.metrics-processor.js');
const { applyProcessingSyncUpdates } = await import('../../../../../core/session/sync-state-utils.js');
const { resolveRunWindow } = await import('../../../../../core/session/run-window.js');

const SESSION_ID = 'claude-window';
const T = Date.parse('2026-09-03T12:00:00.000Z');

let home: string;
let sessionsDir: string;
const previousHome = process.env.CODEMIE_HOME;

const assistant = (uuid: string, offsetMs: number) => ({
  uuid,
  type: 'assistant',
  timestamp: new Date(T + offsetMs).toISOString(),
  sessionId: 'agent-session',
  message: { id: `msg-${uuid}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, model: 'claude-sonnet-4-6' },
});
const transcript = [assistant('before', -1000), assistant('inside', 1000), assistant('later', 11_000)];
const session = { sessionId: SESSION_ID, agentName: 'claude', messages: transcript } as unknown as ParsedSession;

const recordIds = () => readFileSync(join(sessionsDir, `${SESSION_ID}_metrics.jsonl`), 'utf-8').trim().split('\n')
  .map((line) => (JSON.parse(line) as { recordId: string }).recordId);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-window-'));
  process.env.CODEMIE_HOME = home;
  sessionsDir = join(home, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${SESSION_ID}.json`), JSON.stringify({ sessionId: SESSION_ID, startTime: T }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('Claude MetricsProcessor run window', () => {
  it('writes only the message inside [startTime, recordsBeforeMs)', async () => {
    const result = await new MetricsProcessor().process(session, { recordsBeforeMs: T + 10_000 } as never);

    expect(result.success).toBe(true);
    expect(recordIds()).toEqual(['inside']);
  });

  it('a hook process without recordsBeforeMs has no upper bound, only the start bound', async () => {
    const result = await new MetricsProcessor().process(session, { hookProcess: true } as never);

    expect(result.success).toBe(true);
    expect(recordIds()).toEqual(['inside', 'later']);
  });

  it('reports what the writer wrote: two of three deltas outside the window give 1, and the sync state counts 1', async () => {
    const result = await new MetricsProcessor().process(session, { recordsBeforeMs: T + 10_000 } as never);
    const state = { sync: { metrics: { processedRecordIds: [], totalDeltas: 5, totalSynced: 0, totalFailed: 0, lastProcessedTimestamp: 0 } } };
    applyProcessingSyncUpdates(state as never, [result]);

    expect(result.metadata).toMatchObject({ deltasWritten: 1, recordsProcessed: 1 });
    expect(state.sync.metrics.totalDeltas).toBe(6);
  });

  it('an append dropped because the live file is gone is a failure', async () => {
    renameSync(join(sessionsDir, `${SESSION_ID}.json`), join(sessionsDir, `completed_${SESSION_ID}.json`));

    const result = await new MetricsProcessor().process(session, { recordsBeforeMs: T + 10_000 } as never);

    expect(result.success).toBe(false);
    expect(existsSync(join(sessionsDir, `${SESSION_ID}_metrics.jsonl`))).toBe(false);
  });

  it('the metrics and conversation locks held: a run with a short syncDeadlineMs fails near it, nothing written', async () => {
    // A live writer (this test's parent) holds both locks throughout
    for (const kind of ['metrics', 'conversation']) {
      writeFileSync(join(sessionsDir, `${SESSION_ID}.${kind}.lock`), JSON.stringify({ pid: process.ppid }));
    }
    const budgetMs = 200;
    const started = Date.now();

    const result = await new MetricsProcessor().process(session, { hookProcess: true, syncDeadlineMs: started + budgetMs } as never);

    expect(result.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(budgetMs + 1000);
    expect(existsSync(join(sessionsDir, `${SESSION_ID}_metrics.jsonl`))).toBe(false);
  });

  it('resolveRunWindow carries the context\'s deadline, abort signal and pid-only liveness', async () => {
    const signal = new AbortController().signal;

    const window = await resolveRunWindow(SESSION_ID, { syncDeadlineMs: T + 5000, abortSignal: signal, hookProcess: true } as never);

    expect(window).toMatchObject({ startTime: T, deadlineMs: T + 5000, signal, pidOnlyLiveness: true });
  });
});
