/**
 * Gemini re-sends every message of its transcript on every run; the shared writer's recordId dedupe
 * and run window are what keep the metrics file exact.
 *
 * Seam: GeminiMetricsProcessor over the real MetricsWriter on a temp sessions directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ParsedSession } from '../../../../../core/session/BaseSessionAdapter.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), isDebugMode: () => false },
}));

const { GeminiMetricsProcessor } = await import('../gemini.metrics-processor.js');

const SESSION_ID = 'gemini-window';
const T0 = Date.parse('2026-09-03T12:00:00.000Z');

let home: string;
let sessionsDir: string;
const previousHome = process.env.CODEMIE_HOME;

const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const assistant = (id: string, offsetMs: number, extra: Record<string, unknown> = {}) => ({
  id, timestamp: iso(offsetMs), type: 'gemini', model: 'gemini-3-flash', content: 'ok', ...extra,
});
const session = (messages: unknown[]) => ({ sessionId: SESSION_ID, agentName: 'gemini', messages, metrics: {} }) as unknown as ParsedSession;
const context = {} as never;

function writeRecord(startTime: number): void {
  writeFileSync(join(sessionsDir, `${SESSION_ID}.json`), JSON.stringify({ sessionId: SESSION_ID, startTime }));
}
const lines = () => readFileSync(join(sessionsDir, `${SESSION_ID}_metrics.jsonl`), 'utf-8').trim().split('\n')
  .map((l) => JSON.parse(l) as { recordId: string; tools: Record<string, number> });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gemini-window-'));
  process.env.CODEMIE_HOME = home;
  sessionsDir = join(home, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('GeminiMetricsProcessor over the shared writer', () => {
  const transcript = [assistant('m1', 1000), assistant('m2', 2000), assistant('m3', 3000)];

  it('writes 3 / 3 / 3 lines with 3 distinct ids over three runs on one record', async () => {
    writeRecord(T0);
    for (let run = 1; run <= 3; run++) {
      await new GeminiMetricsProcessor().process(session(transcript), context);
      expect(lines()).toHaveLength(3);
    }
    expect(new Set(lines().map((l) => l.recordId))).toEqual(new Set(['m1', 'm2', 'm3']));
  });

  it('writes nothing for a record that started after every message of the transcript', async () => {
    writeRecord(T0 + 10_000);
    const result = await new GeminiMetricsProcessor().process(session(transcript), context);

    expect(result.success).toBe(true);
    expect(() => lines()).toThrow(/ENOENT/);
  });

  it('keeps the first version of a message a mid-turn pass saw (the known freeze)', async () => {
    writeRecord(T0);
    await new GeminiMetricsProcessor().process(session([assistant('m1', 1000)]), context);
    const withTool = assistant('m1', 1000, { toolCalls: [{ id: 'c1', name: 'read_file', args: {}, status: 'success', timestamp: iso(1500) }] });
    await new GeminiMetricsProcessor().process(session([withTool]), context);

    // ponytail: the second pass's version of m1 (with its tool call) is dropped by recordId; a mid-turn pass is hypothetical (gemini runs at AfterAgent and SessionEnd only)
    expect(lines()).toEqual([expect.objectContaining({ recordId: 'm1', tools: {} })]);
  });

  it('gives exactly one new delta for a message appended to the transcript', async () => {
    writeRecord(T0);
    await new GeminiMetricsProcessor().process(session(transcript), context);
    expect(lines()).toHaveLength(3);
    const firstRun = lines();

    const appended = [...transcript, assistant('m4', 4000)];
    for (let run = 2; run <= 3; run++) {
      await new GeminiMetricsProcessor().process(session(appended), context);
      expect(lines().map((l) => l.recordId)).toEqual(['m1', 'm2', 'm3', 'm4']);
    }
    expect(lines().slice(0, 3)).toEqual(firstRun);
  });

  it('writes only the messages inside [startTime, recordsBeforeMs)', async () => {
    writeRecord(T0 + 1500);
    const result = await new GeminiMetricsProcessor().process(session(transcript), { recordsBeforeMs: T0 + 3000 } as never);

    expect(result.success).toBe(true);
    expect(lines().map((l) => l.recordId)).toEqual(['m2']);
  });

  it('a hook process without recordsBeforeMs has no upper bound, only the start bound', async () => {
    writeRecord(T0 + 1500);
    const result = await new GeminiMetricsProcessor().process(session(transcript), { hookProcess: true } as never);

    expect(result.success).toBe(true);
    expect(lines().map((l) => l.recordId)).toEqual(['m2', 'm3']);
  });
});
