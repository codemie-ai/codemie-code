/**
 * Spool delivery summary: pending bytes, the endpoint-mismatch hold and live delivery-failure records,
 * read from real spool files and status files in a temp CODEMIE_HOME.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeSpoolDelivery } from '../delivery-summary.js';
import { createStatus, type SessionStatus } from '../session-status.js';
import { spoolRoot, statusFile, streamFile, type SpoolStream } from '../spool-paths.js';

describe('summarizeSpoolDelivery', () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(async () => {
    prev = process.env.CODEMIE_HOME;
    home = await mkdtemp(join(tmpdir(), 'otlp-delivery-summary-'));
    process.env.CODEMIE_HOME = home;
    await mkdir(spoolRoot(), { recursive: true });
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  async function session(
    id: string,
    sizes: Partial<Record<SpoolStream, number>>,
    patch: (status: SessionStatus) => void = () => undefined
  ): Promise<void> {
    for (const [stream, size] of Object.entries(sizes)) {
      await writeFile(streamFile(id, stream as SpoolStream), 'x'.repeat(size));
    }
    const status = createStatus();
    patch(status);
    await writeFile(statusFile(id), JSON.stringify(status));
  }

  const failure = (cursor: number, end: number, nextAt: number, detail?: string): NonNullable<SessionStatus['delivery']>['hooks'] => ({
    reason: 'delivery_failed', since: 1000, cursor, end, attempts: 1, nextAt, ...(detail ? { detail } : {}),
  });

  it('reports nothing for an empty or missing spool', async () => {
    await rm(spoolRoot(), { recursive: true, force: true });
    expect(await summarizeSpoolDelivery()).toEqual({ pendingBytes: 0, mismatchHeld: false });
  });

  it('sums unsent bytes across streams and sessions', async () => {
    await session('a', { hooks: 100, logs: 50 }, (s) => { s.cursors.hooks = 40; });
    await session('b', { metricsJson: 30 });
    expect(await summarizeSpoolDelivery()).toEqual({ pendingBytes: 60 + 50 + 30, mismatchHeld: false });
  });

  it('flags a mismatch hold only while the session has pending data', async () => {
    const hold = (s: SessionStatus): void => { s.holds = { session: { reason: 'analytics_endpoint_mismatch', since: 1 } }; };
    await session('held', { hooks: 10 }, hold);
    expect((await summarizeSpoolDelivery()).mismatchHeld).toBe(true);
    await rm(streamFile('held', 'hooks'));
    await session('held', { hooks: 10 }, (s) => { hold(s); s.cursors.hooks = 10; });
    expect((await summarizeSpoolDelivery()).mismatchHeld).toBe(false);
  });

  it('ignores every other hold reason', async () => {
    await session('other', { hooks: 10 }, (s) => { s.holds = { session: { reason: 'stamp_pending', since: 1 } }; });
    expect(await summarizeSpoolDelivery()).toEqual({ pendingBytes: 10, mismatchHeld: false });
  });

  it('reports a live delivery-failure record with its retry time and detail', async () => {
    await session('failing', { hooks: 100 }, (s) => { s.delivery = { hooks: failure(0, 100, 2000, 'http_503') }; });
    expect((await summarizeSpoolDelivery()).sendFailure).toEqual({ nextAt: 2000, detail: 'http_503' });
  });

  it('reports the earliest retry across streams and sessions, with the detail of that same record', async () => {
    await session('late', { hooks: 100, logs: 100 }, (s) => {
      s.delivery = { hooks: failure(0, 100, 9000, 'http_500'), logs: failure(0, 100, 5000, 'http_502') };
    });
    await session('early', { hooks: 100 }, (s) => { s.delivery = { hooks: failure(0, 100, 3000, 'request_error') }; });
    await session('unreachable-late', { hooks: 100 }, (s) => { s.delivery = { hooks: failure(0, 100, 7000) }; });
    expect((await summarizeSpoolDelivery()).sendFailure).toEqual({ nextAt: 3000, detail: 'request_error' });
  });

  it('omits the detail when the earliest failure record has none', async () => {
    await session('no-detail', { hooks: 100 }, (s) => { s.delivery = { hooks: failure(0, 100, 1500) }; });
    expect((await summarizeSpoolDelivery()).sendFailure).toEqual({ nextAt: 1500 });
  });

  it('ignores a failure record whose cursor has moved', async () => {
    await session('moved', { hooks: 100 }, (s) => { s.cursors.hooks = 50; s.delivery = { hooks: failure(0, 100, 2000) }; });
    expect((await summarizeSpoolDelivery()).sendFailure).toBeUndefined();
  });

  it('ignores a failure record whose file is shorter than its end', async () => {
    await session('short', { hooks: 60 }, (s) => { s.delivery = { hooks: failure(0, 100, 2000) }; });
    expect((await summarizeSpoolDelivery()).sendFailure).toBeUndefined();
  });

  it('counts the stream files of a corrupt status as pending and sets no flags', async () => {
    await writeFile(streamFile('corrupt', 'hooks'), 'x'.repeat(25));
    await writeFile(streamFile('corrupt', 'logs'), 'x'.repeat(5));
    await writeFile(statusFile('corrupt'), '{not json');
    expect(await summarizeSpoolDelivery()).toEqual({ pendingBytes: 30, mismatchHeld: false });
  });

  it('reports the newest drop across sessions: a local no_project loss after a backend discard', async () => {
    await session('discarded', {}, (s) => {
      s.lastDiscard = { reason: 'cli_analytics_disabled', stream: 'hooks', bytes: 10, at: 1_000 };
    });
    await session('no-project', {}, (s) => {
      s.lastLoss = { reason: 'no_project', at: 2_000, bytes: 200, stream: 'hooks' };
    });
    expect((await summarizeSpoolDelivery()).latestDrop).toEqual({ reason: 'no_project', stream: 'hooks', at: 2_000, local: true });
  });

  it('reports a retention-bound loss newer than every discard, without a stream', async () => {
    await session('mixed', {}, (s) => {
      s.lastDiscard = { reason: 'project_context_required', stream: 'hooks', bytes: 10, at: 1_000 };
      s.lastLoss = { reason: 'delivery_failed', at: 3_000, bytes: 50 };
    });
    expect((await summarizeSpoolDelivery()).latestDrop).toEqual({ reason: 'delivery_failed', at: 3_000, local: true });
  });
});
