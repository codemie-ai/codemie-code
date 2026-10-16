/**
 * Spool I/O: atomic hook ingest with project binding, and the locked snapshots.
 * Real temp spool root, real session lock.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ root: '', failNextAppend: false }));

// Real fs, except appendFile can be told to reject once (the bytes-landing step of appendSpool).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    appendFile: (...args: Parameters<typeof actual.appendFile>): Promise<void> => {
      if (state.failNextAppend) {
        state.failNextAppend = false;
        return Promise.reject(new Error('ENOSPC: simulated append failure'));
      }
      return actual.appendFile(...args);
    },
  };
});

vi.mock('../spool-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../spool-paths.js')>();
  const { join: pathJoin } = await import('node:path');
  return {
    ...actual,
    spoolRoot: (): string => state.root,
    streamFile: (sessionId: string, stream: string): string => {
      const ext: Record<string, string> = {
        hooks: '.hooks.ndjson',
        logs: '.otel_logs.bin',
        metrics: '.otel_metrics.bin',
        traces: '.otel_traces.bin',
      };
      return pathJoin(state.root, sessionId + ext[stream]);
    },
    statusFile: (sessionId: string): string => pathJoin(state.root, sessionId + '.status'),
  };
});

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = 'sess-1';

/** One spool line as the daemon stores it: envelope around the wire event. */
function hookLine(project?: string): string {
  const event: Record<string, unknown> = { type: 'agent.tool.end', session_id: SESSION };
  if (project !== undefined) event['codemie_project_name'] = project;
  return JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify(event) }) + '\n';
}

const file = (name: string): string => join(state.root, `${SESSION}.${name}`);

describe('appendSpool — project binding', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-spool-io-'));
  });
  afterEach(async () => {
    await rm(state.root, { recursive: true, force: true });
  });

  it('records a conflict for a mixed first batch and binds nothing', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus } = await import('../session-status.js');

    await appendSpool(SESSION, 'hooks', hookLine('A') + hookLine('B'), ['A', 'B']);

    const status = await readStatus(SESSION);
    expect(status?.projectConflict).toEqual(['A', 'B']);
    expect(status?.project).toBeUndefined();
  });

  it('records a late conflict after the cursor advanced over bound hooks', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus, advanceCursor } = await import('../session-status.js');

    const first = hookLine('A');
    await appendSpool(SESSION, 'hooks', first, ['A']);
    await advanceCursor(SESSION, 'hooks', Buffer.byteLength(first));
    expect((await readStatus(SESSION))?.project).toBe('A');

    await appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);

    const status = await readStatus(SESSION);
    expect(status?.projectConflict).toEqual(['A', 'B']);
    expect(status?.cursors.hooks).toBe(Buffer.byteLength(first));
  });

  it('keeps the binding and the conflict across a restart', async () => {
    const { appendSpool } = await import('../spool-io.js');
    await appendSpool(SESSION, 'hooks', hookLine('A'), ['A']);

    vi.resetModules();
    let { readStatus } = await import('../session-status.js');
    expect((await readStatus(SESSION))?.project).toBe('A');

    const io = await import('../spool-io.js');
    await io.appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);

    vi.resetModules();
    ({ readStatus } = await import('../session-status.js'));
    expect((await readStatus(SESSION))?.projectConflict).toEqual(['A', 'B']);
  });

  it('treats another case as the same project, keeps the first spelling, ignores blanks', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus } = await import('../session-status.js');

    await appendSpool(SESSION, 'hooks', hookLine(''), ['', '  ']);
    let status = await readStatus(SESSION);
    expect(status?.project).toBeUndefined();
    expect(status?.projectConflict).toBeUndefined();

    await appendSpool(SESSION, 'hooks', hookLine('Alpha'), ['Alpha']);
    await appendSpool(SESSION, 'hooks', hookLine('ALPHA'), ['ALPHA', '']);
    status = await readStatus(SESSION);
    expect(status?.project).toBe('Alpha');
    expect(status?.projectConflict).toBeUndefined();
  });

  describe('legacy session (status without projectScanned, hooks file present)', () => {
    async function seedLegacy(lines: string): Promise<void> {
      const { writeStatus, createStatus } = await import('../session-status.js');
      await writeFile(file('hooks.ndjson'), lines);
      await writeStatus(SESSION, createStatus());
    }

    it('binds the single project found on disk and persists it', async () => {
      await seedLegacy(hookLine('A') + hookLine('a'));
      const { appendSpool } = await import('../spool-io.js');
      const { readStatus } = await import('../session-status.js');

      await appendSpool(SESSION, 'hooks', hookLine(), []);

      const status = await readStatus(SESSION);
      expect(status).toMatchObject({ project: 'A', projectScanned: true });
      expect(status?.projectConflict).toBeUndefined();
    });

    it('records a conflict when the disk holds two projects', async () => {
      await seedLegacy(hookLine('A') + hookLine('B'));
      const { appendSpool } = await import('../spool-io.js');
      const { readStatus } = await import('../session-status.js');

      await appendSpool(SESSION, 'hooks', hookLine(), []);

      expect((await readStatus(SESSION))?.projectConflict).toEqual(['A', 'B']);
    });

    it('stays unbound for blank names and never rescans', async () => {
      await seedLegacy(hookLine('') + hookLine());
      const { appendSpool } = await import('../spool-io.js');
      const { readStatus } = await import('../session-status.js');

      await appendSpool(SESSION, 'hooks', hookLine(), []);
      let status = await readStatus(SESSION);
      expect(status?.projectScanned).toBe(true);
      expect(status?.project).toBeUndefined();
      expect(status?.projectConflict).toBeUndefined();

      await appendFile(file('hooks.ndjson'), hookLine('A') + hookLine('B'));
      await appendSpool(SESSION, 'hooks', hookLine(), []);
      status = await readStatus(SESSION);
      expect(status?.project).toBeUndefined();
      expect(status?.projectConflict).toBeUndefined();
    });
  });

  it('still appends the hook bytes on conflict and resets the cursor of a recreated file', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus, writeStatus, createStatus } = await import('../session-status.js');
    await appendSpool(SESSION, 'hooks', hookLine('A') + hookLine('B'), ['A', 'B']);
    const before = Buffer.byteLength(hookLine('A') + hookLine('B'));

    await appendSpool(SESSION, 'hooks', hookLine('C'), ['C']);

    const { readFile } = await import('node:fs/promises');
    expect((await readFile(file('hooks.ndjson'))).length).toBe(before + Buffer.byteLength(hookLine('C')));

    await rm(file('hooks.ndjson'));
    const status = (await readStatus(SESSION)) ?? createStatus();
    status.cursors.hooks = 999;
    await writeStatus(SESSION, status);

    await appendSpool(SESSION, 'hooks', hookLine('A'), ['A']);

    expect((await readStatus(SESSION))?.cursors.hooks).toBe(0);
  });

  it('records the conflict before the bytes land, so a failed append is retried safely', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus } = await import('../session-status.js');
    const { readFile } = await import('node:fs/promises');
    const first = hookLine('A');
    const conflicting = hookLine('B');
    await appendSpool(SESSION, 'hooks', first, ['A']); // bound to A, projectScanned true

    state.failNextAppend = true;
    await expect(appendSpool(SESSION, 'hooks', conflicting, ['B'])).rejects.toThrow(/ENOSPC/);

    expect((await readStatus(SESSION))?.projectConflict).toEqual(['A', 'B']);
    expect(await readFile(file('hooks.ndjson'), 'utf-8')).toBe(first);

    await appendSpool(SESSION, 'hooks', conflicting, ['B']); // client retries the same batch

    expect((await readStatus(SESSION))?.projectConflict).toEqual(['A', 'B']);
    expect(await readFile(file('hooks.ndjson'), 'utf-8')).toBe(first + conflicting);
  });

  it('keeps the OTEL append path unchanged', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus } = await import('../session-status.js');

    await appendSpool(SESSION, 'logs', Buffer.from('abc'));

    const status = await readStatus(SESSION);
    expect(status?.cursors).toEqual({ hooks: 0, logs: 0, metrics: 0, traces: 0 });
    expect(status?.projectScanned).toBeUndefined();
  });
});

describe('snapshots — project gate under the lock', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-spool-gate-'));
  });
  afterEach(async () => {
    await rm(state.root, { recursive: true, force: true });
  });

  async function seedOtel(): Promise<void> {
    const { appendSpool } = await import('../spool-io.js');
    await appendSpool(SESSION, 'logs', Buffer.from('L'));
    await appendSpool(SESSION, 'metrics', Buffer.from('MM'));
    await appendSpool(SESSION, 'traces', Buffer.from('TTT'));
  }

  async function expectAllCursorsAtEof(hooksSize: number): Promise<void> {
    const { readStatus } = await import('../session-status.js');
    expect((await readStatus(SESSION))?.cursors).toEqual({
      hooks: hooksSize,
      logs: 1,
      metrics: 2,
      traces: 3,
    });
  }

  it('returns bytes plus the project for a bound session', async () => {
    const { appendSpool, snapshotPendingBytes, snapshotPendingHookRecords } = await import(
      '../spool-io.js'
    );
    await appendSpool(SESSION, 'hooks', hookLine('A'), ['A']);
    await seedOtel();

    const hooks = await snapshotPendingHookRecords(SESSION);
    const logs = await snapshotPendingBytes(SESSION, 'logs');

    expect(hooks).toMatchObject({ project: 'A', cursor: 0 });
    expect(hooks?.records).toHaveLength(1);
    expect(logs?.project).toBe('A');
    expect(logs?.bytes.toString()).toBe('L');
  });

  it('returns null and discards every stream for a conflicted session', async () => {
    const { appendSpool, snapshotPendingBytes, snapshotPendingHookRecords } = await import(
      '../spool-io.js'
    );
    const hooks = hookLine('A') + hookLine('B');
    await appendSpool(SESSION, 'hooks', hooks, ['A', 'B']);
    await seedOtel();

    expect(await snapshotPendingBytes(SESSION, 'logs')).toBeNull();
    await expectAllCursorsAtEof(Buffer.byteLength(hooks));
    expect(await snapshotPendingHookRecords(SESSION)).toBeNull();
  });

  it('returns null and discards every stream for an unbound session', async () => {
    const { appendSpool, snapshotPendingBytes, snapshotPendingHookRecords } = await import(
      '../spool-io.js'
    );
    const hooks = hookLine('') + hookLine();
    await appendSpool(SESSION, 'hooks', hooks, ['']);
    await seedOtel();

    expect(await snapshotPendingHookRecords(SESSION)).toBeNull();
    await expectAllCursorsAtEof(Buffer.byteLength(hooks));
    expect(await snapshotPendingBytes(SESSION, 'traces')).toBeNull();
  });

  it('runs the legacy scan from the snapshot: a single name binds, two conflict', async () => {
    const { snapshotPendingBytes } = await import('../spool-io.js');
    const { writeStatus, createStatus, readStatus } = await import('../session-status.js');
    await writeFile(file('hooks.ndjson'), hookLine('A'));
    await writeFile(file('otel_logs.bin'), 'L');
    await writeStatus(SESSION, createStatus());

    const bound = await snapshotPendingBytes(SESSION, 'logs');
    expect(bound?.project).toBe('A');
    expect(await readStatus(SESSION)).toMatchObject({ project: 'A', projectScanned: true });

    await rm(file('status'));
    await writeFile(file('hooks.ndjson'), hookLine('A') + hookLine('B'));
    await writeStatus(SESSION, createStatus());

    expect(await snapshotPendingBytes(SESSION, 'logs')).toBeNull();
    const status = await readStatus(SESSION);
    expect(status?.projectConflict).toEqual(['A', 'B']);
    expect(status?.cursors.logs).toBe(1);
  });

  it('nulls all three OTLP snapshots after a late conflict', async () => {
    const { appendSpool, snapshotPendingBytes } = await import('../spool-io.js');
    await appendSpool(SESSION, 'hooks', hookLine('A'), ['A']);
    await seedOtel();
    await appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);

    expect(await snapshotPendingBytes(SESSION, 'logs')).toBeNull();
    expect(await snapshotPendingBytes(SESSION, 'metrics')).toBeNull();
    expect(await snapshotPendingBytes(SESSION, 'traces')).toBeNull();
  });

  it('isSendAllowed is true for the snapshotted range while bound and false after a conflict without a seal', async () => {
    const { appendSpool, isSendAllowed } = await import('../spool-io.js');
    const range = { cursor: 0, end: 1, filtered: false };
    expect(await isSendAllowed(SESSION, 'hooks', 'A', range)).toBe(false); // no status

    await appendSpool(SESSION, 'hooks', hookLine('A'), ['A']);
    expect(await isSendAllowed(SESSION, 'hooks', 'a', range)).toBe(true);
    expect(await isSendAllowed(SESSION, 'hooks', 'B', range)).toBe(false);
    expect(await isSendAllowed(SESSION, 'hooks', 'A', { ...range, cursor: 5, end: 9 })).toBe(false); // not the next range
    expect(await isSendAllowed(SESSION, 'hooks', 'A', { ...range, filtered: true })).toBe(false); // bound: unfiltered only

    // a session that never had a bound project has no seal: after a conflict nothing may go out
    await rm(file('status'));
    await rm(file('hooks.ndjson'));
    await appendSpool(SESSION, 'hooks', hookLine('B') + hookLine('C'), ['B', 'C']);
    expect(await isSendAllowed(SESSION, 'hooks', 'B', range)).toBe(false);
    expect(await isSendAllowed(SESSION, 'hooks', 'C', range)).toBe(false);
  });
});

describe('hooks seal — provably-original hooks survive a project switch', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-spool-seal-'));
    delete process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD;
    vi.resetModules(); // the once-per-session warn memory lives in the module
  });
  afterEach(async () => {
    delete process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD;
    vi.clearAllMocks();
    await rm(state.root, { recursive: true, force: true });
  });

  const bytes = (...lines: string[]): number => Buffer.byteLength(lines.join(''));

  /** Bound to A with two A hooks and a blank one, OTLP on all three streams, then a B hook. */
  async function switchToB(): Promise<{ a1: string; blank: string; a2: string; b: string; sealEnd: number }> {
    const { appendSpool } = await import('../spool-io.js');
    const a1 = hookLine('A');
    const blank = hookLine();
    const a2 = hookLine('a');
    const b = hookLine('B');
    await appendSpool(SESSION, 'hooks', a1, ['A']);
    await appendSpool(SESSION, 'hooks', blank, ['']);
    await appendSpool(SESSION, 'hooks', a2, ['a']);
    await appendSpool(SESSION, 'logs', Buffer.from('L')); // arrived BEFORE the conflicting hook
    await appendSpool(SESSION, 'metrics', Buffer.from('MM'));
    await appendSpool(SESSION, 'traces', Buffer.from('TTT'));
    await appendSpool(SESSION, 'hooks', b, ['B']);
    return { a1, blank, a2, b, sealEnd: bytes(a1, blank, a2) };
  }

  it('writes the seal with the exact size before the conflicting append, and before its bytes', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus } = await import('../session-status.js');
    const { readFile } = await import('node:fs/promises');
    const a = hookLine('A');
    const b = hookLine('B');
    await appendSpool(SESSION, 'hooks', a, ['A']);

    state.failNextAppend = true;
    await expect(appendSpool(SESSION, 'hooks', b, ['B'])).rejects.toThrow(/ENOSPC/);

    const sealed = (await readStatus(SESSION))?.projectSeal;
    expect(sealed).toEqual({ v: 1, project: 'A', hooksEnd: bytes(a) });
    expect(await readFile(file('hooks.ndjson'), 'utf-8')).toBe(a);

    await appendSpool(SESSION, 'hooks', b, ['B']); // retried batch lands after the seal
    expect((await readStatus(SESSION))?.projectSeal).toEqual(sealed);
    expect(await readFile(file('hooks.ndjson'), 'utf-8')).toBe(a + b);
  });

  it('writes no seal when nothing was bound or the conflict comes from a legacy scan', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus, writeStatus, createStatus } = await import('../session-status.js');
    await appendSpool(SESSION, 'hooks', hookLine('A') + hookLine('B'), ['A', 'B']); // mixed first batch
    let status = await readStatus(SESSION);
    expect(status?.projectConflict).toEqual(['A', 'B']);
    expect(status?.projectSeal).toBeUndefined();

    await rm(file('status'));
    await rm(file('hooks.ndjson'));
    await writeFile(file('hooks.ndjson'), hookLine('A') + hookLine('B'));
    await writeStatus(SESSION, createStatus());
    await appendSpool(SESSION, 'hooks', hookLine(), []);
    status = await readStatus(SESSION);
    expect(status?.projectConflict).toEqual(['A', 'B']);
    expect(status?.projectSeal).toBeUndefined();
  });

  it('sends only records that are provably A below the seal; blank and later records are consumed unsent', async () => {
    const { snapshotPendingHookRecords } = await import('../spool-io.js');
    const { a1, a2, b, sealEnd } = await switchToB();

    const batch = await snapshotPendingHookRecords(SESSION);

    expect(batch).toMatchObject({ project: 'A', cursor: 0, byteLength: sealEnd, dropped: 1 });
    expect(batch?.records).toEqual([a1.trim(), a2.trim()]);
    expect(batch?.records).not.toContain(b.trim());
    expect(await snapshotPendingHookRecords(SESSION)).toEqual(batch); // same bytes on every retry
  });

  it('never sends OTLP, including chunks that arrived before the conflicting hook or after the seal', async () => {
    const { appendSpool, snapshotPendingBytes } = await import('../spool-io.js');
    const { readStatus } = await import('../session-status.js');
    await switchToB();

    for (const stream of ['logs', 'metrics', 'traces'] as const) {
      expect(await snapshotPendingBytes(SESSION, stream)).toBeNull();
    }
    expect((await readStatus(SESSION))?.cursors).toMatchObject({ logs: 1, metrics: 2, traces: 3 });

    await appendSpool(SESSION, 'logs', Buffer.from('late'));
    expect(await snapshotPendingBytes(SESSION, 'logs')).toBeNull();
    expect((await readStatus(SESSION))?.cursors.logs).toBe(5);
  });

  it('discards the rest of the hooks once the sealed prefix is consumed, and later hooks never flow', async () => {
    const { appendSpool, snapshotPendingHookRecords } = await import('../spool-io.js');
    const { readStatus, advanceCursor } = await import('../session-status.js');
    const { a1, blank, a2, b, sealEnd } = await switchToB();

    await advanceCursor(SESSION, 'hooks', sealEnd);
    expect(await snapshotPendingHookRecords(SESSION)).toBeNull();
    expect((await readStatus(SESSION))?.cursors.hooks).toBe(bytes(a1, blank, a2, b));

    await appendSpool(SESSION, 'hooks', hookLine('A'), ['A']); // even an A hook after the conflict
    expect(await snapshotPendingHookRecords(SESSION)).toBeNull();
    expect((await readStatus(SESSION))?.cursors.hooks).toBe(bytes(a1, blank, a2, b, hookLine('A')));
  });

  it('completes at the file size when the seal end is beyond the file: no endless wait', async () => {
    const { appendSpool, snapshotPendingHookRecords } = await import('../spool-io.js');
    const { readStatus, writeStatus, advanceCursor } = await import('../session-status.js');
    const a = hookLine('A');
    await appendSpool(SESSION, 'hooks', a, ['A']);
    const status = (await readStatus(SESSION))!;
    status.projectConflict = ['A', 'B'];
    status.projectSeal = { v: 1, project: 'A', hooksEnd: 10_000 };
    await writeStatus(SESSION, status);

    const batch = await snapshotPendingHookRecords(SESSION);
    expect(batch).toMatchObject({ project: 'A', byteLength: bytes(a) });

    await advanceCursor(SESSION, 'hooks', bytes(a));
    expect(await snapshotPendingHookRecords(SESSION)).toBeNull();
  });

  it('consumes a partial record at the end of the sealed prefix instead of waiting for it', async () => {
    const { appendSpool, snapshotPendingHookRecords } = await import('../spool-io.js');
    const { advanceCursor } = await import('../session-status.js');
    const a = hookLine('A');
    const torn = '{"agentName":"x","hookEvent":"{\\"codemie_pro';
    await appendSpool(SESSION, 'hooks', a, ['A']);
    await appendSpool(SESSION, 'hooks', torn, []); // crash left a partial record
    await appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);

    const first = await snapshotPendingHookRecords(SESSION);
    expect(first?.records).toHaveLength(1);
    await advanceCursor(SESSION, 'hooks', first!.byteLength);

    const second = await snapshotPendingHookRecords(SESSION);
    expect(second).toMatchObject({ records: [], byteLength: Buffer.byteLength(torn) });
    await advanceCursor(SESSION, 'hooks', Buffer.byteLength(a) + second!.byteLength);
    expect(await snapshotPendingHookRecords(SESSION)).toBeNull();
  });

  it('isSendAllowed lets a sealed session send its hooks prefix, never an OTLP stream or a wider range', async () => {
    const { isSendAllowed } = await import('../spool-io.js');
    const { sealEnd } = await switchToB();
    const range = { cursor: 0, end: sealEnd, filtered: true };

    expect(await isSendAllowed(SESSION, 'hooks', 'A', range)).toBe(true);
    expect(await isSendAllowed(SESSION, 'hooks', 'a', range)).toBe(true);
    expect(await isSendAllowed(SESSION, 'hooks', 'B', range)).toBe(false);
    expect(await isSendAllowed(SESSION, 'hooks', 'A', { ...range, end: sealEnd + 1 })).toBe(false);
    expect(await isSendAllowed(SESSION, 'hooks', 'A', { ...range, cursor: 3 })).toBe(false);
    for (const stream of ['logs', 'metrics', 'traces'] as const) {
      expect(await isSendAllowed(SESSION, stream, 'A', { cursor: 0, end: 1, filtered: false })).toBe(false);
    }
  });

  it('isSendAllowed refuses a stale unfiltered snapshot once the session is sealed, keeping the cursor', async () => {
    const { appendSpool, snapshotPendingHookRecords, isSendAllowed } = await import('../spool-io.js');
    const { readStatus } = await import('../session-status.js');
    const a1 = hookLine('A');
    const blank = hookLine();
    await appendSpool(SESSION, 'hooks', a1, ['A']);
    await appendSpool(SESSION, 'hooks', blank, ['']);

    const bound = await snapshotPendingHookRecords(SESSION); // built while bound: unfiltered, blank included
    expect(bound).toMatchObject({ project: 'A', filtered: false });
    expect(bound?.records).toEqual([a1.trim(), blank.trim()]);

    await appendSpool(SESSION, 'hooks', hookLine('B'), ['B']); // conflict persisted after the snapshot
    const range = { cursor: bound!.cursor, end: bound!.cursor + bound!.byteLength, filtered: bound!.filtered };

    expect(await isSendAllowed(SESSION, 'hooks', 'A', range)).toBe(false);
    expect((await readStatus(SESSION))?.cursors.hooks).toBe(0); // nothing acknowledged or lost

    const sealed = await snapshotPendingHookRecords(SESSION); // the next pass re-snapshots through the filter
    expect(sealed).toMatchObject({ project: 'A', filtered: true, cursor: 0, dropped: 1 });
    expect(sealed?.records).toEqual([a1.trim()]);
    expect(
      await isSendAllowed(SESSION, 'hooks', 'A', { cursor: 0, end: sealed!.byteLength, filtered: sealed!.filtered })
    ).toBe(true);
  });

  it('with OTLP_ALLOW_HOOKS_ONLY_FORWARD=false the sealed prefix is discarded too, as before', async () => {
    process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD = 'false';
    const { snapshotPendingHookRecords, isSendAllowed } = await import('../spool-io.js');
    const { readStatus } = await import('../session-status.js');
    const { a1, blank, a2, b, sealEnd } = await switchToB();

    expect(await isSendAllowed(SESSION, 'hooks', 'A', { cursor: 0, end: sealEnd, filtered: true })).toBe(false);
    expect(await snapshotPendingHookRecords(SESSION)).toBeNull();
    expect((await readStatus(SESSION))?.cursors.hooks).toBe(bytes(a1, blank, a2, b));
  });

  it('drops a seal that points into an older incarnation of the hooks file, keeping the conflict', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus } = await import('../session-status.js');
    await switchToB();
    expect((await readStatus(SESSION))?.projectSeal).toBeDefined();

    await rm(file('hooks.ndjson'));
    await appendSpool(SESSION, 'hooks', hookLine('A'), ['A']);

    const status = await readStatus(SESSION);
    expect(status?.projectSeal).toBeUndefined();
    expect(status?.projectConflict).toEqual(['A', 'B']);
    expect(status?.cursors.hooks).toBe(0);
  });

  it('keeps the seal across a daemon restart', async () => {
    const { sealEnd } = await switchToB();

    vi.resetModules();
    const { readStatus } = await import('../session-status.js');
    expect((await readStatus(SESSION))?.projectSeal).toEqual({ v: 1, project: 'A', hooksEnd: sealEnd });
  });

  it('warns once at the switch and once when the unsent backlog is discarded, not on every tick', async () => {
    const { logger } = await import('@/utils/logger.js');
    const { snapshotPendingBytes } = await import('../spool-io.js');
    await switchToB();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await snapshotPendingBytes(SESSION, 'logs');
    await snapshotPendingBytes(SESSION, 'metrics');
    expect(logger.warn).toHaveBeenCalledTimes(2);

    const { appendSpool } = await import('../spool-io.js');
    await appendSpool(SESSION, 'logs', Buffer.from('more'));
    await snapshotPendingBytes(SESSION, 'logs');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
