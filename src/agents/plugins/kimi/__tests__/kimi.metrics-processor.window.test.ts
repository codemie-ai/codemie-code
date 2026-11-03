/**
 * The run window keeps a record to its own slice of the transcript: [startTime, upper bound).
 *
 * Seam: KimiMetricsProcessor over the real MetricsWriter and run window on a temp sessions directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ParsedSession } from '../../../core/session/BaseSessionAdapter.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), isDebugMode: () => false },
}));

const { KimiMetricsProcessor } = await import('../session/processors/kimi.metrics-processor.js');

const SESSION_ID = 'kimi-window';
const T = Date.parse('2026-09-03T12:00:00.000Z');

let home: string;
let sessionsDir: string;
const previousHome = process.env.CODEMIE_HOME;

const stepEnd = (uuid: string, offsetMs: number) => ({
  type: 'context.append_loop_event', time: T + offsetMs, event: { type: 'step.end', uuid },
});
const session = {
  sessionId: SESSION_ID,
  agentName: 'Kimi Code',
  messages: [stepEnd('before', -1000), stepEnd('inside', 1000), stepEnd('later', 11_000)],
  metadata: {},
} as unknown as ParsedSession;

const recordIds = () => readFileSync(join(sessionsDir, `${SESSION_ID}_metrics.jsonl`), 'utf-8').trim().split('\n')
  .map((line) => (JSON.parse(line) as { recordId: string }).recordId);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kimi-window-'));
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

describe('KimiMetricsProcessor run window', () => {
  it('writes only the step inside [startTime, recordsBeforeMs)', async () => {
    const result = await new KimiMetricsProcessor().process(session, { recordsBeforeMs: T + 10_000 } as never);

    expect(result.success).toBe(true);
    expect(recordIds()).toEqual(['inside']);
  });

  it('a hook process without recordsBeforeMs has no upper bound, only the start bound', async () => {
    const result = await new KimiMetricsProcessor().process(session, { hookProcess: true } as never);

    expect(result.success).toBe(true);
    expect(recordIds()).toEqual(['inside', 'later']);
  });
});
