import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const advanceCursorMock = vi.fn(async () => undefined);
const readStatusMock = vi.fn(async () => null as { endedAt?: number; cursors?: Record<string, number>; delivery?: Record<string, unknown> } | null);
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
    writeSpool('s4', '.otel_logs.ndjson', '{"a":1}\n', grace);
    writeSpool('s4', '.otel_metrics.ndjson', '{"b":22}\n', grace);

    expect(await holdForIdleReopen('s4')).toBe(true);
    expect(advanceCursorMock).toHaveBeenCalledWith('s4', 'logsJson', 8, expect.objectContaining({ reason: 'idle_reopen_expired', stream: 'logsJson' }));
    expect(advanceCursorMock).toHaveBeenCalledWith('s4', 'metricsJson', 9, expect.objectContaining({ stream: 'metricsJson' }));
  });

  it('cuts the given-up records at the last whole line', async () => {
    const { holdForIdleReopen } = await import('../reopen-hold.js');
    writeState('s6', { reopened: true });
    writeSpool('s6', '.otel_logs.ndjson', '{"a":1}\n{"b":2', 61 * 60 * 1000);

    expect(await holdForIdleReopen('s6')).toBe(true);
    expect(advanceCursorMock).toHaveBeenCalledWith('s6', 'logsJson', 8, expect.anything());
  });

  it('does not let go of earlier records that still wait for a retry', async () => {
    const { holdForIdleReopen } = await import('../reopen-hold.js');
    writeState('s7', { reopened: true });
    readStatusMock.mockResolvedValue({ delivery: { logsJson: { cursor: 0, end: 8 } } });
    writeSpool('s7', '.otel_logs.ndjson', '{"a":1}\n', 61 * 60 * 1000);

    expect(await holdForIdleReopen('s7')).toBe(true);
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('has nothing to give up when the cursor already covers the whole lines', async () => {
    const { holdForIdleReopen } = await import('../reopen-hold.js');
    writeState('s8', { reopened: true });
    readStatusMock.mockResolvedValue({ cursors: { logsJson: 8 } });
    writeSpool('s8', '.otel_logs.ndjson', '{"a":1}\n', 61 * 60 * 1000);

    expect(await holdForIdleReopen('s8')).toBe(true);
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('keeps holding while the session still writes records', async () => {
    const { holdForIdleReopen } = await import('../reopen-hold.js');
    writeState('s5', { reopened: true });
    writeSpool('s5', '.otel_logs.ndjson', '{"a":1}\n', 61 * 60 * 1000);
    writeSpool('s5', '.otel_metrics.ndjson', '{"b":1}\n', 1000);

    expect(await holdForIdleReopen('s5')).toBe(true);
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  describe('a reopen that goes on to work', () => {
    const startup = '{"body":{"stringValue":"claude_code.hook_registered"}}\n{"body":{"stringValue":"claude_code.user_prompt"}}\n';
    const work = '{"body":{"stringValue":"claude_code.api_request"}}\n';

    it('keeps holding while only startup records are there', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('w1', { reopened: true });
      writeSpool('w1', '.otel_logs.ndjson', startup);

      expect(await holdForIdleReopen('w1')).toBe(true);
    });

    it('releases the held records at the first model request, without waiting for a Stop', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('w2', { reopened: true });
      const path = writeSpool('w2', '.otel_logs.ndjson', startup);
      expect(await holdForIdleReopen('w2')).toBe(true);

      appendFileSync(path, work);
      expect(await holdForIdleReopen('w2')).toBe(false);
      expect(advanceCursorMock).not.toHaveBeenCalled();
    });

    it('keeps releasing what the session writes after that', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('w3', { reopened: true });
      const path = writeSpool('w3', '.otel_logs.ndjson', startup + work);
      expect(await holdForIdleReopen('w3')).toBe(false);

      appendFileSync(path, '{"body":{"stringValue":"claude_code.hook_execution_complete"}}\n');
      expect(await holdForIdleReopen('w3')).toBe(false);
    });

    it('looks only past the cursor: work that was already forwarded does not release a later idle reopen', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('w4', { reopened: true });
      const before = startup + work;
      writeSpool('w4', '.otel_logs.ndjson', before + startup);
      readStatusMock.mockResolvedValue({ cursors: { logsJson: Buffer.byteLength(before) } });

      expect(await holdForIdleReopen('w4')).toBe(true);
    });
  });

  describe('startup race after the status was swept', () => {
    function stateAged(sessionId: string, ageMs: number): void {
      writeState(sessionId, { sessionStartedAt: '2026-11-01T10:00:00.000Z' });
      const when = new Date(Date.now() - ageMs);
      utimesSync(join(home, 'analytics', 'state', `${sessionId}.json`), when, when);
    }

    it('holds a spool file created just now for a session whose saved state is much older', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      stateAged('b1', 3 * 24 * 60 * 60 * 1000);
      writeSpool('b1', '.otel_logs.ndjson', '{"a":1}\n');

      expect(await holdForIdleReopen('b1')).toBe(true);
    });

    it('does not hold a new ordinary session whose state was written just before its first records', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      stateAged('b2', 2000);
      writeSpool('b2', '.otel_logs.ndjson', '{"a":1}\n');

      expect(await holdForIdleReopen('b2')).toBe(false);
    });

    it('is bounded by the settle time: bytes last written longer ago go out', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      stateAged('b3', 3 * 24 * 60 * 60 * 1000);
      writeSpool('b3', '.otel_logs.ndjson', '{"a":1}\n', 60_000);

      expect(await holdForIdleReopen('b3')).toBe(false);
    });

    it('holds nothing for a session without a saved start', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeSpool('b4', '.otel_logs.ndjson', '{"a":1}\n');

      expect(await holdForIdleReopen('b4')).toBe(false);
    });
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
