import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const advanceCursorMock = vi.fn(async () => undefined);
const readStatusMock = vi.fn(async () => null as { endedAt?: number; lastEndedAt?: number; endedSizes?: Record<string, number>; reopenWorkAt?: number; cursors?: Record<string, number>; delivery?: Record<string, unknown> } | null);
const updateStatusMock = vi.fn(async (_id: string, mutate: (status: Record<string, unknown>) => void) => mutate({}));
vi.mock('../session-status.js', () => ({ advanceCursor: advanceCursorMock, readStatus: readStatusMock, updateStatus: updateStatusMock }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let home: string;
const previousHome = process.env.CODEMIE_HOME;

function writeState(sessionId: string, fields: Record<string, unknown>): void {
  mkdirSync(join(home, 'analytics', 'state'), { recursive: true });
  writeFileSync(join(home, 'analytics', 'state', `${sessionId}.json`), JSON.stringify(fields));
}
function writeSpool(sessionId: string, ext: string, body: string | Buffer, ageMs = 0): string {
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
  updateStatusMock.mockClear();
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

  it('lets the hold go after the grace when earlier records still wait for a retry, dropping nothing', async () => {
    const { holdForIdleReopen } = await import('../reopen-hold.js');
    writeState('s7', { reopened: true });
    readStatusMock.mockResolvedValue({ delivery: { logsJson: { cursor: 0, end: 8 } } });
    writeSpool('s7', '.otel_logs.ndjson', '{"a":1}\n', 61 * 60 * 1000);

    expect(await holdForIdleReopen('s7')).toBe(false);
    expect(advanceCursorMock).not.toHaveBeenCalled();
  });

  it('still holds a pending retry until the grace has passed', async () => {
    const { holdForIdleReopen } = await import('../reopen-hold.js');
    writeState('s7b', { reopened: true });
    readStatusMock.mockResolvedValue({ delivery: { logsJson: { cursor: 0, end: 8 } } });
    writeSpool('s7b', '.otel_logs.ndjson', '{"a":1}\n', 10 * 60 * 1000);

    expect(await holdForIdleReopen('s7b')).toBe(true);
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
    /** One OTLP/JSON export line with one log record per name, shaped like Claude Code's. */
    const exportOf = (names: string[], extra: Record<string, string> = {}): string =>
      JSON.stringify({
        resourceLogs: [{
          scopeLogs: [{
            logRecords: names.map((name) => ({
              body: { stringValue: `claude_code.${name}` },
              attributes: [
                { key: 'event.name', value: { stringValue: name } },
                ...Object.entries(extra).map(([key, value]) => ({ key, value: { stringValue: value } })),
              ],
            })),
          }],
        }],
      }) + '\n';
    const startup = exportOf(['hook_registered', 'plugin_loaded']) + exportOf(['user_prompt']);
    const work = exportOf(['api_request']);

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

      appendFileSync(path, exportOf(['hook_execution_complete']));
      expect(await holdForIdleReopen('w3')).toBe(false);
    });

    it('stays released when a later hook pass saves the parse state again', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      const reopenedAt = Date.now() - 60_000;
      writeState('w5', { reopened: true, reopenedAt });
      const path = writeSpool('w5', '.otel_logs.ndjson', startup + work);
      expect(await holdForIdleReopen('w5')).toBe(false);

      writeState('w5', { reopened: true, reopenedAt }); // an idle Stop pass saves the state: newer mtime
      appendFileSync(path, exportOf(['hook_execution_complete']));
      expect(await holdForIdleReopen('w5')).toBe(false);
    });

    it('holds again after a new reopen has marked the state', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('w6', { reopened: true, reopenedAt: Date.now() - 60_000 });
      const path = writeSpool('w6', '.otel_logs.ndjson', startup + work);
      expect(await holdForIdleReopen('w6')).toBe(false);

      readStatusMock.mockResolvedValue({ cursors: { logsJson: Buffer.byteLength(startup + work) } });
      writeState('w6', { reopened: true, reopenedAt: Date.now() + 1000 }); // second resume, nothing done yet
      appendFileSync(path, startup);
      expect(await holdForIdleReopen('w6')).toBe(true);
    });

    it('records the release on the status, so it survives a daemon restart', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('d1', { reopened: true });
      writeSpool('d1', '.otel_logs.ndjson', startup + work);

      expect(await holdForIdleReopen('d1')).toBe(false);
      expect(updateStatusMock).toHaveBeenCalledWith('d1', expect.any(Function));
      const status: Record<string, unknown> = {};
      await updateStatusMock.mock.calls[0][1](status);
      expect(typeof status['reopenWorkAt']).toBe('number');
    });

    it('stays released from the status alone (memory lost), as long as it is not older than the reopen', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      const reopenedAt = Date.now() - 60_000;
      writeState('d2', { reopened: true, reopenedAt });
      writeSpool('d2', '.otel_logs.ndjson', startup);
      readStatusMock.mockResolvedValue({ reopenWorkAt: reopenedAt + 5000 });

      expect(await holdForIdleReopen('d2')).toBe(false);
    });

    it('holds again when the status release belongs to an earlier reopen', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      const reopenedAt = Date.now() - 60_000;
      writeState('d3', { reopened: true, reopenedAt });
      writeSpool('d3', '.otel_logs.ndjson', startup);
      readStatusMock.mockResolvedValue({ reopenWorkAt: reopenedAt - 5000 });

      expect(await holdForIdleReopen('d3')).toBe(true);
    });

    it('scans a spool file that was created again after the sweep from its start, not from the old offset', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('n1', { reopened: true });
      const path = writeSpool('n1', '.otel_logs.ndjson', startup + startup);
      expect(await holdForIdleReopen('n1')).toBe(true); // everything in it was scanned, no work

      rmSync(path);
      writeSpool('n1', '.otel_logs.ndjson', work); // shorter than the old offset, work at its very start
      expect(await holdForIdleReopen('n1')).toBe(false);
    });

    it('releases the records of a session that is not marked as a reopen yet but works after its SessionEnd', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('ended1', { sessionStartedAt: '2026-11-01T10:00:00.000Z' });
      readStatusMock.mockResolvedValue({ endedAt: Date.now() - 60_000 });
      writeSpool('ended1', '.otel_logs.ndjson', startup + work);

      expect(await holdForIdleReopen('ended1')).toBe(false);
    });

    it('holds startup records after a SessionEnd of a session not marked yet, and stays released once it worked', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('ended2', { sessionStartedAt: '2026-11-01T10:00:00.000Z' });
      readStatusMock.mockResolvedValue({ endedAt: Date.now() - 60_000 });
      const path = writeSpool('ended2', '.otel_logs.ndjson', startup);
      expect(await holdForIdleReopen('ended2')).toBe(true);

      appendFileSync(path, work);
      expect(await holdForIdleReopen('ended2')).toBe(false);
      appendFileSync(path, exportOf(['hook_execution_complete'])); // no work in this chunk: no hold again
      expect(await holdForIdleReopen('ended2')).toBe(false);
    });

    it('does not take the words in some other record for work', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('w7', { reopened: true });
      writeSpool(
        'w7',
        '.otel_logs.ndjson',
        exportOf(['hook_registered'], { command: 'api_request', note: 'claude_code.tool_result', 'plugin.name': '"api_request"' })
      );

      expect(await holdForIdleReopen('w7')).toBe(true);
    });

    it('finds work in a protobuf log stream by its prefixed event name', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('w8', { reopened: true });
      writeSpool('w8', '.otel_logs.bin', 'xx claude_code.hook_registered yy');
      expect(await holdForIdleReopen('w8')).toBe(true);

      writeSpool('w8', '.otel_logs.bin', 'xx claude_code.hook_registered yy claude_code.api_request zz');
      expect(await holdForIdleReopen('w8')).toBe(false);
    });

    it('does not take a bare api_request word in a protobuf stream for work', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('w9', { reopened: true });
      writeSpool('w9', '.otel_logs.bin', 'xx claude_code.hook_registered api_request tool_result');

      expect(await holdForIdleReopen('w9')).toBe(true);
    });

    describe('giving up after the abandoned-session grace', () => {
      const old = 61 * 60 * 1000;

      it('cuts a protobuf stream at its end, never at a newline byte inside a message', async () => {
        const { holdForIdleReopen } = await import('../reopen-hold.js');
        writeState('g1', { reopened: true });
        const body = Buffer.concat([Buffer.from([0x0a, 0x05]), Buffer.from('abcde'), Buffer.from([0x0a, 0x01, 0x78])]);
        writeSpool('g1', '.otel_logs.bin', body, old);

        expect(await holdForIdleReopen('g1')).toBe(true);
        expect(advanceCursorMock).toHaveBeenCalledWith('g1', 'logs', body.length, expect.objectContaining({ reason: 'idle_reopen_expired' }));
      });

      it('looks past the first scanned chunk for work before dropping anything', async () => {
        const { holdForIdleReopen } = await import('../reopen-hold.js');
        writeState('g2', { reopened: true });
        const filler = exportOf(['hook_registered'], { pad: 'x'.repeat(1000) });
        const lines = Math.ceil((8 * 1024 * 1024 + 4096) / Buffer.byteLength(filler));
        writeSpool('g2', '.otel_logs.ndjson', filler.repeat(lines) + work, old);

        expect(await holdForIdleReopen('g2')).toBe(false);
        expect(advanceCursorMock).not.toHaveBeenCalled();
      });
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

  describe('a reopen that worked and is resumed again without a prompt', () => {
    const exportOf = (names: string[]): string =>
      JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: names.map((name) => ({ body: { stringValue: `claude_code.${name}` }, attributes: [{ key: 'event.name', value: { stringValue: name } }] })) }] }] }) + '\n';
    const startup = exportOf(['hook_registered', 'plugin_loaded']);
    const work = exportOf(['api_request']);
    const ago = (ms: number): number => Date.now() - ms;

    it('keeps the startup records of the second resume back while the hook has not re-armed the hold', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('x1', { reopened: true, reopenActive: true, reopenedAt: ago(600_000) });
      readStatusMock.mockResolvedValue({ lastEndedAt: ago(60_000), reopenWorkAt: ago(300_000), endedSizes: { logsJson: 0 } });
      writeSpool('x1', '.otel_logs.ndjson', startup);

      expect(await holdForIdleReopen('x1')).toBe(true);
    });

    it('lets it go at once when the resumed session works', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('x2', { reopened: true, reopenActive: true, reopenedAt: ago(600_000) });
      readStatusMock.mockResolvedValue({ lastEndedAt: ago(60_000), reopenWorkAt: ago(300_000) });
      writeSpool('x2', '.otel_logs.ndjson', startup + work);

      expect(await holdForIdleReopen('x2')).toBe(false);
      expect(updateStatusMock).toHaveBeenCalled();
    });

    it('does not take work from before that end for work of the resume', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('x3', { reopened: true, reopenActive: true, reopenedAt: ago(600_000) });
      readStatusMock.mockResolvedValue({ lastEndedAt: ago(60_000), endedSizes: { logsJson: Buffer.byteLength(work) } });
      writeSpool('x3', '.otel_logs.ndjson', work + startup);

      expect(await holdForIdleReopen('x3')).toBe(true);
    });

    it.each([
      ['no end was recorded', { reopenWorkAt: 1 }, 1000],
      ['the bytes are older than the settle time', { lastEndedAt: Date.now() - 600_000 }, 60_000],
      ['the bytes were written before that end', { lastEndedAt: Date.now() + 5_000 }, 1000],
      ['the session worked after that end', { lastEndedAt: Date.now() - 60_000, reopenWorkAt: Date.now() - 30_000 }, 1000],
    ])('does not hold when %s', async (_name, status, age) => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('x4', { reopened: true, reopenActive: true, reopenedAt: ago(600_000) });
      readStatusMock.mockResolvedValue(status);
      writeSpool('x4', '.otel_logs.ndjson', startup, age);

      expect(await holdForIdleReopen('x4')).toBe(false);
    });
  });

  describe('records of the run that ended which were never sent', () => {
    const exportOf = (names: string[]): string =>
      JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: names.map((name) => ({ body: { stringValue: `claude_code.${name}` }, attributes: [{ key: 'event.name', value: { stringValue: name } }] })) }] }] }) + '\n';
    const earlier = exportOf(['api_request']) + exportOf(['tool_result']);
    const startup = exportOf(['hook_registered', 'plugin_loaded']);
    const old = 61 * 60 * 1000;

    it('are not dropped with the reopen startup records: the hold is let go after the grace', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('u1', { reopened: true });
      readStatusMock.mockResolvedValue({ cursors: { logsJson: 0 }, endedSizes: { logsJson: Buffer.byteLength(earlier) } });
      writeSpool('u1', '.otel_logs.ndjson', earlier + startup, old);

      expect(await holdForIdleReopen('u1')).toBe(false);
      expect(advanceCursorMock).not.toHaveBeenCalled();
    });

    it('their own work records do not release the hold of an idle reopen before the grace', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('u2', { reopened: true });
      readStatusMock.mockResolvedValue({ cursors: { logsJson: 0 }, endedSizes: { logsJson: Buffer.byteLength(earlier) } });
      writeSpool('u2', '.otel_logs.ndjson', earlier + startup, 1000);

      expect(await holdForIdleReopen('u2')).toBe(true);
    });

    it('once they are sent, only the reopen bytes are dropped', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      writeState('u3', { reopened: true });
      readStatusMock.mockResolvedValue({ cursors: { logsJson: Buffer.byteLength(earlier) }, endedSizes: { logsJson: Buffer.byteLength(earlier) } });
      writeSpool('u3', '.otel_logs.ndjson', earlier + startup, old);

      expect(await holdForIdleReopen('u3')).toBe(true);
      expect(advanceCursorMock).toHaveBeenCalledWith('u3', 'logsJson', Buffer.byteLength(earlier + startup), expect.objectContaining({ reason: 'idle_reopen_expired' }));
    });
  });

  describe('a session that was killed (no SessionEnd) and is resumed', () => {
    const exportOf = (names: string[]): string =>
      JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: names.map((name) => ({ body: { stringValue: `claude_code.${name}` }, attributes: [{ key: 'event.name', value: { stringValue: name } }] })) }] }] }) + '\n';
    const startup = exportOf(['hook_registered', 'plugin_loaded']);
    // The spool file is born "now" in a test, which the swept-spool rule would take for a resume. Looking 16 s ahead
    // (past the settle time since its birth) with bytes written 6 s from now leaves only the quiet-hooks rule.
    const BORN_AGO = 16_000;
    const clock = (): number => Date.now() + BORN_AGO;
    function killedState(sessionId: string, quietMs: number): void {
      writeState(sessionId, { sessionStartedAt: '2026-11-01T10:00:00.000Z' });
      const when = new Date(Date.now() - quietMs);
      utimesSync(join(home, 'analytics', 'state', `${sessionId}.json`), when, when);
    }

    it('keeps back the bytes that appear after a long quiet in the hooks', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      killedState('k1', 30 * 60 * 1000);
      readStatusMock.mockResolvedValue({});
      writeSpool('k1', '.otel_logs.ndjson', startup, -6000);

      expect(await holdForIdleReopen('k1', clock())).toBe(true);
    });

    it('lets go of an ordinary session that goes on with a model request, and stays let go', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      killedState('k2', 30 * 60 * 1000);
      readStatusMock.mockResolvedValue({});
      writeSpool('k2', '.otel_logs.ndjson', startup + exportOf(['api_request']), -6000);
      const now = clock();

      expect(await holdForIdleReopen('k2', now)).toBe(false);
      expect(await holdForIdleReopen('k2', now)).toBe(false);
    });

    it.each([
      ['the hooks were active a moment ago', 20_000, -6000],
      ['the bytes are older than the settle time', 30 * 60 * 1000, 60_000],
    ])('does not hold when %s', async (_name, quietMs, age) => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      killedState('k3', quietMs);
      readStatusMock.mockResolvedValue({});
      writeSpool('k3', '.otel_logs.ndjson', startup, age);

      expect(await holdForIdleReopen('k3', clock())).toBe(false);
    });

    it('holds nothing for a session without a saved start or without a saved state', async () => {
      const { holdForIdleReopen } = await import('../reopen-hold.js');
      readStatusMock.mockResolvedValue({});
      writeSpool('k4', '.otel_logs.ndjson', startup, 1000);
      expect(await holdForIdleReopen('k4')).toBe(false);
      writeState('k5', {});
      writeSpool('k5', '.otel_logs.ndjson', startup, 1000);
      expect(await holdForIdleReopen('k5')).toBe(false);
    });
  });
});
