/**
 * Ingest/forwarding interleaving: the decision to send is made under the same lock as the
 * hook append that can introduce a conflicting project. Real spool root and real lock;
 * only fetch, the daemon state and the logger are faked. Ordering uses deferreds, not timers.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));
const readStateMock = vi.hoisted(() => vi.fn());

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
// The only seam between the hooks snapshot and the locked pre-send check: `send()` asks this right after
// the snapshot, so a hook armed here can queue a spool append that the next locked call must follow.
const authHook = vi.hoisted(() => ({ onStaleCheck: undefined as undefined | (() => void) }));
vi.mock('../auth-state.js', () => ({
  areCredentialsStale: (): boolean => {
    authHook.onStaleCheck?.();
    return false;
  },
  markCredentialsStale: vi.fn(),
}));
vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({ readState: readStateMock }));
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = 'sess-1';
const credentials = { cookies: { codemie_access_token: 'tok' }, apiUrl: 'https://api', timestamp: 0 };

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function hookLine(project: string): string {
  const event = { type: 'agent.tool.end', session_id: SESSION, codemie_project_name: project };
  return JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify(event) }) + '\n';
}

describe('project gate — ingest vs forwarding', () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-interleave-'));
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://api.example.com' });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(async () => {
    authHook.onStaleCheck = undefined;
    vi.unstubAllGlobals();
    await rm(state.root, { recursive: true, force: true });
  });

  /** Session bound to A with hooks and all three OTLP streams pending. */
  async function seedBoundA(): Promise<void> {
    const { appendSpool } = await import('../spool-io.js');
    await appendSpool(SESSION, 'hooks', hookLine('A'), ['A']);
    await appendSpool(SESSION, 'logs', Buffer.from('L'));
    await appendSpool(SESSION, 'metrics', Buffer.from('MM'));
    await appendSpool(SESSION, 'traces', Buffer.from('TTT'));
  }

  async function cursorsAtEof(hooksSize: number): Promise<void> {
    const { readStatus } = await import('../session-status.js');
    expect((await readStatus(SESSION))?.cursors).toEqual({
      hooks: hooksSize,
      logs: 1,
      metrics: 2,
      traces: 3,
    });
  }

  it('A. the queue order is the lock order', async () => {
    const { appendSpool, snapshotPendingBytes } = await import('../spool-io.js');
    const { withSessionLock } = await import('../session-lock.js');
    await seedBoundA();

    // append(B) queued before the snapshot: the snapshot sees the conflict.
    const release = deferred();
    const held = withSessionLock(SESSION, () => release.promise);
    const append = appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);
    const snapshot = snapshotPendingBytes(SESSION, 'logs');
    release.resolve();
    await held;
    await append;
    expect(await snapshot).toBeNull();
  });

  it('A. a snapshot queued before the append sees project A, the append then persists the conflict', async () => {
    const { appendSpool, snapshotPendingBytes } = await import('../spool-io.js');
    const { withSessionLock } = await import('../session-lock.js');
    const { readStatus } = await import('../session-status.js');
    await seedBoundA();

    const release = deferred();
    const held = withSessionLock(SESSION, () => release.promise);
    const snapshot = snapshotPendingBytes(SESSION, 'logs');
    const append = appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);
    release.resolve();
    await held;
    await append;

    expect(await snapshot).toMatchObject({ project: 'A' });
    expect((await readStatus(SESSION))?.projectConflict).toEqual(['A', 'B']);
  });

  it('B. a request already in flight is the stated limit; nothing else is sent after the conflict', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { forwardSession } = await import('../forwarder.js');
    await seedBoundA();
    const events: string[] = [];
    const started = deferred();
    const response = deferred<{ ok: boolean; status: number }>();
    fetchMock.mockImplementation(async (_url: string, init: { headers: Record<string, string> }) => {
      events.push(`fetch:${init.headers['X-CodeMie-Project']}`);
      started.resolve();
      return response.promise;
    });

    const pass = forwardSession(SESSION, false, credentials as never);
    await started.promise;
    await appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);
    events.push('conflict-persisted');
    response.resolve({ ok: true, status: 200 });
    await pass;
    await forwardSession(SESSION, false, credentials as never); // next pass drains B's hook

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['fetch:A', 'conflict-persisted']);
    const hooksSize = Buffer.byteLength(hookLine('A') + hookLine('B'));
    await cursorsAtEof(hooksSize);
  });

  it('C. a conflict persisted between the hooks snapshot and the OTLP snapshots stops all OTLP requests', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { forwardSession } = await import('../forwarder.js');
    await seedBoundA();
    fetchMock.mockImplementation(async () => {
      await appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);
      return { ok: true, status: 200 };
    });

    await forwardSession(SESSION, false, credentials as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('event-hooks');
  });

  describe('D. hooks seal, end to end through the real spool and forwarder', () => {
    const aEvent = { type: 'agent.tool.end', session_id: SESSION, codemie_project_name: 'A' };

    it('sends the A hooks under header A and nothing else after a switch to B', async () => {
      const { appendSpool } = await import('../spool-io.js');
      const { forwardSession } = await import('../forwarder.js');
      await seedBoundA(); // A hook + OTLP chunks that arrived before the switch
      await appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);

      await forwardSession(SESSION, true, credentials as never); // what the tick does for a sealed session
      await forwardSession(SESSION, true, credentials as never);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://api.example.com/v1/analytics/cli-analytics/event-hooks');
      expect(init.headers['X-CodeMie-Project']).toBe('A');
      expect(init.body).toBe(`${JSON.stringify(aEvent)}\n`);
      await cursorsAtEof(Buffer.byteLength(hookLine('A') + hookLine('B')));
    });

    it('a failed send leaves the cursor, and the retry sends the same bytes', async () => {
      const { appendSpool } = await import('../spool-io.js');
      const { forwardSession } = await import('../forwarder.js');
      const { readStatus } = await import('../session-status.js');
      await seedBoundA();
      await appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });

      await forwardSession(SESSION, true, credentials as never);
      expect((await readStatus(SESSION))?.cursors.hooks).toBe(0);

      await forwardSession(SESSION, true, credentials as never);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
      expect((await readStatus(SESSION))?.cursors.hooks).toBe(Buffer.byteLength(hookLine('A'))); // the sealed prefix only
    });

    describe('E. a conflict persisted after an unfiltered bound snapshot was built', () => {
      const aLine = hookLine('A');
      const blankLine = hookLine(''); // not provably A's: must never leave once the session is sealed
      const bLine = hookLine('B');

      async function seedBoundWithBlank(): Promise<void> {
        const { appendSpool } = await import('../spool-io.js');
        await appendSpool(SESSION, 'hooks', aLine, ['A']);
        await appendSpool(SESSION, 'hooks', blankLine, ['']);
      }

      async function expectOnlyProvablyAFlushed(callIndex: number): Promise<void> {
        const { readStatus } = await import('../session-status.js');
        const [url, init] = fetchMock.mock.calls[callIndex];
        expect(String(url)).toContain('event-hooks');
        expect(init.headers['X-CodeMie-Project']).toBe('A');
        expect(init.body).toBe(`${JSON.stringify({ type: 'agent.tool.end', session_id: SESSION, codemie_project_name: 'A' })}\n`);
        expect((await readStatus(SESSION))?.cursors.hooks).toBe(Buffer.byteLength(aLine + blankLine));
      }

      it('between the snapshot and the pre-send check: nothing is posted, the cursor stays, the next pass sends only A', async () => {
        const { appendSpool } = await import('../spool-io.js');
        const { forwardSession } = await import('../forwarder.js');
        const { readStatus } = await import('../session-status.js');
        await seedBoundWithBlank();
        let conflictAppend: Promise<void> | undefined;
        authHook.onStaleCheck = (): void => {
          authHook.onStaleCheck = undefined;
          conflictAppend = appendSpool(SESSION, 'hooks', bLine, ['B']); // queued on the lock before the check
        };

        await forwardSession(SESSION, true, credentials as never);
        await conflictAppend;

        expect(fetchMock).not.toHaveBeenCalled();
        const status = await readStatus(SESSION);
        expect(status?.cursors.hooks).toBe(0);
        expect(status?.projectSeal).toEqual({ v: 1, project: 'A', hooksEnd: Buffer.byteLength(aLine + blankLine) });

        await forwardSession(SESSION, true, credentials as never); // re-snapshot through the filter
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await expectOnlyProvablyAFlushed(0);
      });

      it('on the 401 retry: the retry built from the same bound snapshot is refused, then only A is sent', async () => {
        const { appendSpool } = await import('../spool-io.js');
        const { forwardSession } = await import('../forwarder.js');
        await seedBoundWithBlank();
        fetchMock.mockReset();
        fetchMock.mockImplementationOnce(async () => {
          await appendSpool(SESSION, 'hooks', bLine, ['B']); // conflict lands while the first attempt is on the wire
          return { ok: false, status: 401 };
        });
        fetchMock.mockResolvedValue({ ok: true, status: 200 });

        await forwardSession(SESSION, true, credentials as never);

        expect(fetchMock).toHaveBeenCalledTimes(1); // the 401 retry never reached the wire
        const { readStatus } = await import('../session-status.js');
        expect((await readStatus(SESSION))?.cursors.hooks).toBe(0);

        await forwardSession(SESSION, true, credentials as never);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await expectOnlyProvablyAFlushed(1);
      });
    });

    it('a restart between the switch and the flush loses nothing: the seal is read back from disk', async () => {
      const { appendSpool } = await import('../spool-io.js');
      await seedBoundA();
      await appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);

      vi.resetModules();
      const { forwardSession } = await import('../forwarder.js');
      await forwardSession(SESSION, true, credentials as never);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].headers['X-CodeMie-Project']).toBe('A');
    });
  });
});
