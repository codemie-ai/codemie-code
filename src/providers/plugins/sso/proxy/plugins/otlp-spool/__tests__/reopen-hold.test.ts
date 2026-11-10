import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const advanceCursorMock = vi.fn(async () => undefined);
const readStatusMock = vi.fn(async () => null as { endedAt?: number } | null);
vi.mock('../session-status.js', () => ({ advanceCursor: advanceCursorMock, readStatus: readStatusMock }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let home: string;
const previousHome = process.env.CODEMIE_HOME;

function writeState(sessionId: string, fields: Record<string, unknown>): void {
  mkdirSync(join(home, 'analytics', 'state'), { recursive: true });
  writeFileSync(join(home, 'analytics', 'state', `${sessionId}.json`), JSON.stringify(fields));
}
function writeSpool(sessionId: string, ext: string, body: string, ageMs = 0): string {
  mkdirSync(join(home, 'proxy', 'otlp-spool'), { recursive: true });
  const path = join(home, 'proxy', 'otlp-spool', sessionId + ext);
  writeFileSync(path, body);
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reopen-hold-'));
  process.env.CODEMIE_HOME = home;
  advanceCursorMock.mockClear();
  readStatusMock.mockReset();
  readStatusMock.mockResolvedValue(null);
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('holdForIdleReopen', () => {
  it('holds the otel streams of a reopened session that has no activity of its own', async () => {
    const { holdForIdleReopen } = await import('../reopen-hold.js');
    writeState('s1', { reopened: true });
    writeSpool('s1', '.otel_logs.ndjson', '{"a":1}\n');

    expect(await holdForIdleReopen('s1')).toBe(true);
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('lets the held records go once the session has activity of its own', async () => {
    const { holdForIdleReopen } = await import('../reopen-hold.js');
    writeState('s2', { reopened: true, reopenActive: true });

    expect(await holdForIdleReopen('s2')).toBe(false);
  });

  it.each([
    ['a session that was never reopened', { sessionStartedAt: '2026-11-01T10:00:00.000Z' }],
    ['a session without a saved state', null],
  ])('does not hold %s', async (_name, state) => {
    const { holdForIdleReopen } = await import('../reopen-hold.js');
    if (state) writeState('s3', state);

    expect(await holdForIdleReopen('s3')).toBe(false);
  });

  it('gives up on records of a reopen that stayed idle past the abandoned-session grace, without sending them', async () => {
    const { holdForIdleReopen } = await import('../reopen-hold.js');
    writeState('s4', { reopened: true });
    const grace = 61 * 60 * 1000;
    const logs = writeSpool('s4', '.otel_logs.ndjson', '{"a":1}\n', grace);
    writeSpool('s4', '.otel_metrics.ndjson', '{"b":22}\n', grace);

    expect(await holdForIdleReopen('s4')).toBe(true);
    expect(advanceCursorMock).toHaveBeenCalledWith('s4', 'logsJson', 8, expect.objectContaining({ reason: 'idle_reopen_expired', stream: 'logsJson' }));
    expect(advanceCursorMock).toHaveBeenCalledWith('s4', 'metricsJson', 9, expect.objectContaining({ stream: 'metricsJson' }));
    expect(logs).toContain('s4');
  });

  it('keeps holding while the session still writes records', async () => {
    const { holdForIdleReopen } = await import('../reopen-hold.js');
    writeState('s5', { reopened: true });
    writeSpool('s5', '.otel_logs.ndjson', '{"a":1}\n', 61 * 60 * 1000);
    writeSpool('s5', '.otel_metrics.ndjson', '{"b":1}\n', 1000);

    expect(await holdForIdleReopen('s5')).toBe(true);
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  describe('startup race: records written after the session ended, before the resume hook marked it', () => {
    it('keeps them back for the settle time', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('r1', { sessionStartedAt: '2026-11-01T10:00:00.000Z' });
      readStatusMock.mockResolvedValue({ endedAt: Date.now() - 60_000 });
      writeSpool('r1', '.otel_logs.ndjson', '{"a":1}\n', 1000);

      expect(await holdForIdleReopen('r1')).toBe(true);
    });

    it('lets them go once the settle time has passed', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('r2', { sessionStartedAt: '2026-11-01T10:00:00.000Z' });
      readStatusMock.mockResolvedValue({ endedAt: Date.now() - 120_000 });
      writeSpool('r2', '.otel_logs.ndjson', '{"a":1}\n', 30_000);

      expect(await holdForIdleReopen('r2')).toBe(false);
    });

    it('does not hold bytes written before the session ended', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('r3', { sessionStartedAt: '2026-11-01T10:00:00.000Z' });
      readStatusMock.mockResolvedValue({ endedAt: Date.now() });
      writeSpool('r3', '.otel_logs.ndjson', '{"a":1}\n', 5000);

      expect(await holdForIdleReopen('r3')).toBe(false);
    });

    it('does not hold a session that has not ended', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('r4', { sessionStartedAt: '2026-11-01T10:00:00.000Z' });
      readStatusMock.mockResolvedValue({});
      writeSpool('r4', '.otel_logs.ndjson', '{"a":1}\n', 1000);

      expect(await holdForIdleReopen('r4')).toBe(false);
    });
  });
});
