/**
 * MetricsWriter.appendDeltas: the recordId dedupe, the run window and the file lock.
 *
 * Seam: the writer over a temp sessions directory; no mocks beyond the logger.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MetricDelta } from '@/agents/core/metrics/types.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), isDebugMode: () => false },
}));

const { MetricsWriter } = await import('../MetricsWriter.js');
const { acquirePidLock } = await import('@/utils/pid-lock.js');
const { readJSONLTolerant } = await import('@/agents/core/session/utils/jsonl-reader.js');

const SESSION_ID = '00000000-0000-4000-8000-0000000000dd';
const START = Date.parse('2026-10-01T10:00:00Z');

type NewDelta = Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>;

function delta(recordId: string, timestamp: number | string): NewDelta {
  return { recordId, sessionId: SESSION_ID, agentSessionId: 'native', timestamp, tools: {} };
}

let home: string;
let sessionsDir: string;
const previousHome = process.env.CODEMIE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'metrics-writer-'));
  process.env.CODEMIE_HOME = home;
  sessionsDir = join(home, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  // The live record: the metrics file is created only while it exists
  writeFileSync(join(sessionsDir, `${SESSION_ID}.json`), JSON.stringify({ sessionId: SESSION_ID, startTime: START }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const metricsFile = () => join(sessionsDir, `${SESSION_ID}_metrics.jsonl`);
const lockFile = () => join(sessionsDir, `${SESSION_ID}.metrics.lock`);
const readIds = () => readFileSync(metricsFile(), 'utf-8').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as MetricDelta).recordId);

describe('MetricsWriter.appendDeltas', () => {
  it('writes a recordId once, within a batch and across batches', async () => {
    const writer = new MetricsWriter(SESSION_ID);
    const first = await writer.appendDeltas([delta('a', START + 1), delta('a', START + 1), delta('b', START + 2)], { startTime: START });
    const second = await writer.appendDeltas([delta('b', START + 2), delta('c', START + 3)], { startTime: START });

    expect(first).toEqual({ written: 2, gone: false, dup: 1, beforeStart: 0, afterEnd: 0 });
    expect(second).toEqual({ written: 1, gone: false, dup: 1, beforeStart: 0, afterEnd: 0 });
    expect(readIds()).toEqual(['a', 'b', 'c']);
  });

  it('keeps the lower bound inclusive and the upper bound exclusive', async () => {
    const writer = new MetricsWriter(SESSION_ID);
    const result = await writer.appendDeltas(
      [delta('early', START - 1), delta('at-start', START), delta('inside', START + 5), delta('at-end', START + 10), delta('late', START + 11)],
      { startTime: START, upperBound: START + 10 }
    );

    expect(result).toEqual({ written: 2, gone: false, dup: 0, beforeStart: 1, afterEnd: 2 });
    expect(readIds()).toEqual(['at-start', 'inside']);
  });

  it('reads a time as a number or an ISO string and never judges a non-finite one', async () => {
    const writer = new MetricsWriter(SESSION_ID);
    const result = await writer.appendDeltas(
      [
        delta('iso-early', new Date(START - 1000).toISOString()),
        delta('iso-ok', new Date(START + 1000).toISOString()),
        delta('nan', Number.NaN),
        delta('garbage', 'not a date'),
      ],
      { startTime: START, upperBound: START + 5000 }
    );

    expect(result).toEqual({ written: 3, gone: false, dup: 0, beforeStart: 1, afterEnd: 0 });
    expect(readIds()).toEqual(['iso-ok', 'nan', 'garbage']);
  });

  it('puts no upper bound on a window without one, even for a time in the future', async () => {
    const writer = new MetricsWriter(SESSION_ID);
    const result = await writer.appendDeltas([delta('future', Date.now() + 86_400_000)], { startTime: START });
    expect(result.written).toBe(1);
  });

  it('keeps both batches of two concurrent appends', async () => {
    const one = new MetricsWriter(SESSION_ID);
    const two = new MetricsWriter(SESSION_ID);
    await Promise.all([
      one.appendDeltas(Array.from({ length: 20 }, (_, i) => delta(`one-${i}`, START + i)), { startTime: START }),
      two.appendDeltas(Array.from({ length: 20 }, (_, i) => delta(`two-${i}`, START + i)), { startTime: START }),
    ]);

    const ids = readIds();
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it('waits for a held lock and writes once it is released', async () => {
    const held = await acquirePidLock(lockFile(), { mode: 'try' });
    expect(held).not.toBeNull();
    const pending = new MetricsWriter(SESSION_ID).appendDeltas([delta('waited', START + 1)], { startTime: START });
    // Time-based: the writer polls every 25 ms, so it is still waiting well after this
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(metricsFile())).toBe(false);

    await held!.release();
    expect((await pending).written).toBe(1);
  });

  it('throws, writing nothing, when the lock stays held past the deadline', async () => {
    const held = await acquirePidLock(lockFile(), { mode: 'try' });
    try {
      await expect(
        new MetricsWriter(SESSION_ID).appendDeltas([delta('x', START + 1)], { startTime: START, deadlineMs: Date.now() + 100 })
      ).rejects.toThrow(/Timed out waiting for lock/);
      expect(existsSync(metricsFile())).toBe(false);
    } finally {
      await held!.release();
    }
  });

  it('reclaims a lock held by a dead pid and appends', async () => {
    writeFileSync(lockFile(), JSON.stringify({ pid: 2_147_483_646 }));
    const result = await new MetricsWriter(SESSION_ID).appendDeltas([delta('after-dead', START + 1)], { startTime: START });
    expect(result.written).toBe(1);
  });

  it('skips a torn line when reading the ids on disk', async () => {
    writeFileSync(metricsFile(), `${JSON.stringify({ ...delta('old', START + 1), syncStatus: 'pending', syncAttempts: 0 })}\n{"recordId":"tor`);
    const result = await new MetricsWriter(SESSION_ID).appendDeltas([delta('old', START + 1), delta('new', START + 2)], { startTime: START });
    expect(result).toMatchObject({ written: 1, dup: 1 });
    // The appended line never glues to the torn one: the tolerant reader skips the torn line and yields the new
    expect((await readJSONLTolerant<MetricDelta>(metricsFile())).map((d) => d.recordId)).toEqual(['old', 'new']);
  });

  it('drops an append that finds its record renamed to completed_, creating no live file', async () => {
    const writer = new MetricsWriter(SESSION_ID);
    await writer.appendDeltas([delta('before-rename', START + 1)], { startTime: START });
    renameSync(metricsFile(), join(sessionsDir, `completed_${SESSION_ID}_metrics.jsonl`));
    renameSync(join(sessionsDir, `${SESSION_ID}.json`), join(sessionsDir, `completed_${SESSION_ID}.json`));

    const result = await writer.appendDeltas([delta('after-rename', START + 2)], { startTime: START });

    expect(result).toMatchObject({ written: 0, gone: true });
    expect(existsSync(metricsFile())).toBe(false);
    expect(readFileSync(join(sessionsDir, `completed_${SESSION_ID}_metrics.jsonl`), 'utf-8')).not.toContain('after-rename');
  });

  it('appends one delta to a 20 000-line file quickly (a guard, not a benchmark)', async () => {
    const line = JSON.stringify({ ...delta('filler', START + 1), syncStatus: 'synced', syncAttempts: 1 });
    writeFileSync(metricsFile(), Array.from({ length: 20_000 }, (_, i) => line.replace('"filler"', `"filler-${i}"`)).join('\n') + '\n');

    const startedAt = performance.now();
    const result = await new MetricsWriter(SESSION_ID).appendDeltas([delta('one-more', START + 2)], { startTime: START });

    expect(result.written).toBe(1);
    // Guards against a full-file rewrite or a quadratic scan (seconds at 20 000 lines), not against a slow runner
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it('gives every delta of a batch the id of its sorted record ids, whatever their order', async () => {
    const { deltaIdOf } = await import('../delta-id.js');
    const writer = new MetricsWriter(SESSION_ID);
    await writer.appendDeltas([delta('b', START + 2), delta('a', START + 1)], { startTime: START });

    const lines = readFileSync(metricsFile(), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as MetricDelta & { deltaId?: string });
    expect(lines.map((l) => l.deltaId)).toEqual([deltaIdOf(['a', 'b']), deltaIdOf(['a', 'b'])]);
    expect(deltaIdOf(['b', 'a'])).toBe(deltaIdOf(['a', 'b']));
  });
});
