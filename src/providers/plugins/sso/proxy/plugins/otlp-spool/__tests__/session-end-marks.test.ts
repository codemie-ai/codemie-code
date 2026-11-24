import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let home: string;
const previousHome = process.env.CODEMIE_HOME;
const spool = (sessionId: string, ext: string, bytes: number): void => {
  mkdirSync(join(home, 'proxy', 'otlp-spool'), { recursive: true });
  writeFileSync(join(home, 'proxy', 'otlp-spool', sessionId + ext), Buffer.alloc(bytes, 0x61));
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'session-end-marks-'));
  process.env.CODEMIE_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('markSessionEnded', () => {
  it('records the first end, the latest end and the size of each otel spool file at that moment', async () => {
    const { createStatus, markSessionEnded, readStatus, writeStatus } = await import('../session-status.js');
    await writeStatus('e1', createStatus());
    spool('e1', '.otel_logs.ndjson', 30);
    spool('e1', '.otel_metrics.bin', 7);
    spool('e1', '.hooks.ndjson', 99); // the hooks stream is not an otel stream

    await markSessionEnded('e1');
    const first = await readStatus('e1');
    expect(first?.endedAt).toBeGreaterThan(0);
    expect(first?.lastEndedAt).toBe(first?.endedAt);
    expect(first?.endedSizes).toEqual({ logsJson: 30, metrics: 7 });

    spool('e1', '.otel_logs.ndjson', 80);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await markSessionEnded('e1');
    const second = await readStatus('e1');
    expect(second?.endedAt).toBe(first?.endedAt); // the first end stays
    expect(second?.lastEndedAt).toBeGreaterThan(first?.endedAt ?? 0);
    expect(second?.endedSizes).toEqual({ logsJson: 80, metrics: 7 });
  });

  it('records no sizes when there is no otel spool file', async () => {
    const { createStatus, markSessionEnded, readStatus, writeStatus } = await import('../session-status.js');
    await writeStatus('e2', createStatus());
    await markSessionEnded('e2');

    expect((await readStatus('e2'))?.endedSizes).toBeUndefined();
  });

  it('reads back only well-formed marks from a status on disk', async () => {
    const { readStatus } = await import('../session-status.js');
    mkdirSync(join(home, 'proxy', 'otlp-spool'), { recursive: true });
    writeFileSync(
      join(home, 'proxy', 'otlp-spool', 'e3.status'),
      JSON.stringify({ lastEndedAt: 'x', endedSizes: { logsJson: 12, hooks: 5, metrics: -3, traces: 'big', other: 9 } })
    );

    const status = await readStatus('e3');
    expect(status?.lastEndedAt).toBeUndefined();
    expect(status?.endedSizes).toEqual({ logsJson: 12 });
  });
});
