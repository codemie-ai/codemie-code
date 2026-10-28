/**
 * Ingest/forwarding interleaving: the decision to send is made under the same lock as the
 * hook append that can introduce a conflicting project. Real spool root and real lock;
 * only fetch, the daemon state and the logger are faked. Ordering uses deferreds, not timers.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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

  /**
   * What a bound session's switch to an unsendable name leaves behind: the conflict and a seal ending at
   * the current size of the hooks file, then the conflicting hook line. The returned function takes the
   * session lock before its first await, so a caller inside a hook queues it at that exact point.
   */
  async function conflictSeeder(): Promise<(line: string) => Promise<void>> {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus, writeStatus, createStatus } = await import('../session-status.js');
    const { withSessionLock } = await import('../session-lock.js');
    const { streamFile } = await import('../spool-paths.js');
    return async (line: string): Promise<void> => {
      await withSessionLock(SESSION, async () => {
        const status = (await readStatus(SESSION)) ?? createStatus();
        const hooksEnd = await stat(streamFile(SESSION, 'hooks')).then(
          (info) => info.size,
          () => 0
        );
        status.projectScanned = true;
        status.projectConflict = ['B\u00e9', 'A'];
        if (status.project) status.projectSeal = { v: 1, project: status.project, hooksEnd };
        await writeStatus(SESSION, status);
      });
      await appendSpool(SESSION, 'hooks', line, ['B\u00e9']);
    };
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

  it('A. an unsendable name queued before the snapshot does not stop it', async () => {
    const { appendSpool, snapshotPendingBytes } = await import('../spool-io.js');
    const { withSessionLock } = await import('../session-lock.js');
    await seedBoundA();

    // append(Bé) queued before the snapshot: the session is bound, so the snapshot still returns A's bytes.
    const release = deferred();
    const held = withSessionLock(SESSION, () => release.promise);
    const append = appendSpool(SESSION, 'hooks', hookLine('B\u00e9'), ['B\u00e9']);
    const snapshot = snapshotPendingBytes(SESSION, 'logs');
    release.resolve();
    await held;
    await append;
    expect(await snapshot).toMatchObject({ project: 'A' });
  });

  it('A. a snapshot queued before the append sees project A, and the append leaves the binding alone', async () => {
    const { appendSpool, snapshotPendingBytes } = await import('../spool-io.js');
    const { withSessionLock } = await import('../session-lock.js');
    const { readStatus } = await import('../session-status.js');
    await seedBoundA();

    const release = deferred();
    const held = withSessionLock(SESSION, () => release.promise);
    const snapshot = snapshotPendingBytes(SESSION, 'logs');
    const append = appendSpool(SESSION, 'hooks', hookLine('B\u00e9'), ['B\u00e9']);
    release.resolve();
    await held;
    await append;

    expect(await snapshot).toMatchObject({ project: 'A' });
    const status = await readStatus(SESSION);
    expect(status?.project).toBe('A');
    expect(status?.projectConflict).toBeUndefined();
  });

  it('B. an unsendable name arriving during a request in flight changes nothing: OTLP follows under A', async () => {
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
    await appendSpool(SESSION, 'hooks', hookLine('B\u00e9'), ['B\u00e9']);
    events.push('unsendable-appended');
    response.resolve({ ok: true, status: 200 });
    await pass;
    await forwardSession(SESSION, false, credentials as never); // next pass drains the unsendable hook unsent

    expect(fetchMock).toHaveBeenCalledTimes(4); // hooks, then logs, metrics and traces
    expect(events).toEqual(['fetch:A', 'unsendable-appended', 'fetch:A', 'fetch:A', 'fetch:A']);
    const hooksSize = Buffer.byteLength(hookLine('A') + hookLine('B\u00e9'));
    await cursorsAtEof(hooksSize);
  });

  it('C. an unsendable name persisted between the hooks snapshot and the OTLP snapshots does not stop the OTLP requests', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { forwardSession } = await import('../forwarder.js');
    await seedBoundA();
    fetchMock.mockImplementationOnce(async () => {
      await appendSpool(SESSION, 'hooks', hookLine('B\u00e9'), ['B\u00e9']);
      return { ok: true, status: 200 };
    });

    await forwardSession(SESSION, false, credentials as never);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[0][0])).toContain('event-hooks');
    const otlp = fetchMock.mock.calls.slice(1);
    expect(otlp.map(([url]) => String(url)).some((url) => url.includes('event-hooks'))).toBe(false);
    expect(otlp.map(([, init]) => init.headers['X-CodeMie-Project'])).toEqual(['A', 'A', 'A']);
  });

  describe('D. hooks seal, end to end through the real spool and forwarder', () => {
    const aEvent = { type: 'agent.tool.end', session_id: SESSION, codemie_project_name: 'A' };

    it('sends the A hooks under header A and nothing else after a switch to B', async () => {
      const seedConflict = await conflictSeeder();
      const { forwardSession } = await import('../forwarder.js');
      await seedBoundA(); // A hook + OTLP chunks that arrived before the switch
      await seedConflict(hookLine('B\u00e9'));

      await forwardSession(SESSION, true, credentials as never); // what the tick does for a sealed session
      await forwardSession(SESSION, true, credentials as never);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://api.example.com/v1/analytics/cli-analytics/event-hooks');
      expect(init.headers['X-CodeMie-Project']).toBe('A');
      expect(init.body).toBe(`${JSON.stringify(aEvent)}\n`);
      await cursorsAtEof(Buffer.byteLength(hookLine('A') + hookLine('B\u00e9')));
    });

    it('a failed send leaves the cursor, and the retry sends the same bytes', async () => {
      const seedConflict = await conflictSeeder();
      const { forwardSession } = await import('../forwarder.js');
      const { readStatus } = await import('../session-status.js');
      await seedBoundA();
      await seedConflict(hookLine('B\u00e9'));
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
      const bLine = hookLine('B\u00e9');

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
        const seedConflict = await conflictSeeder();
        const { forwardSession } = await import('../forwarder.js');
        const { readStatus } = await import('../session-status.js');
        await seedBoundWithBlank();
        let conflictAppend: Promise<void> | undefined;
        authHook.onStaleCheck = (): void => {
          authHook.onStaleCheck = undefined;
          conflictAppend = seedConflict(bLine); // queued on the lock before the check
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
        const seedConflict = await conflictSeeder();
        const { forwardSession } = await import('../forwarder.js');
        await seedBoundWithBlank();
        fetchMock.mockReset();
        fetchMock.mockImplementationOnce(async () => {
          await seedConflict(bLine); // conflict lands while the first attempt is on the wire
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
      const seedConflict = await conflictSeeder();
      await seedBoundA();
      await seedConflict(hookLine('B\u00e9'));

      vi.resetModules();
      const { forwardSession } = await import('../forwarder.js');
      await forwardSession(SESSION, true, credentials as never);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].headers['X-CodeMie-Project']).toBe('A');
    });
  });

  describe('F. several sendable projects in one session, end to end through the real spool and forwarder', () => {
    interface HookEvent {
      type: string;
      session_id: string;
      codemie_project_name?: string;
      tag: string;
    }

    const event = (project: string | undefined, tag: string, type = 'agent.tool.end'): HookEvent => ({
      type,
      session_id: SESSION,
      ...(project === undefined ? {} : { codemie_project_name: project }),
      tag,
    });
    const lineOf = (e: HookEvent): string =>
      JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify(e) }) + '\n';
    const bodyOf = (...events: HookEvent[]): string => events.map((e) => `${JSON.stringify(e)}\n`).join('');

    async function appendEvents(...events: HookEvent[]): Promise<void> {
      const { appendSpool } = await import('../spool-io.js');
      for (const e of events) {
        await appendSpool(SESSION, 'hooks', lineOf(e), e.codemie_project_name === undefined ? [] : [e.codemie_project_name]);
      }
    }

    function hooksRequests(): Array<{ project: string; body: string }> {
      return fetchMock.mock.calls
        .filter(([url]) => String(url).includes('event-hooks'))
        .map(([, init]) => ({ project: init.headers['X-CodeMie-Project'], body: String(init.body) }));
    }

    async function hooksCursor(): Promise<number | undefined> {
      const { readStatus } = await import('../session-status.js');
      return (await readStatus(SESSION))?.cursors.hooks;
    }

    const a1 = event('A', 'a1');
    const b1 = event('B', 'b1');
    const a2 = event('A', 'a2');

    it('sends one request per project and moves the cursor to the end only after both are accepted', async () => {
      const { forwardSession } = await import('../forwarder.js');
      await seedBoundA(); // a1 is hookLine('A'); the OTLP streams are pending too
      await appendEvents(b1, a2);
      const total = Buffer.byteLength(hookLine('A') + lineOf(b1) + lineOf(a2));
      const cursorAtEachHooksRequest: Array<number | undefined> = [];
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).includes('event-hooks')) cursorAtEachHooksRequest.push(await hooksCursor());
        return { ok: true, status: 200 };
      });

      await forwardSession(SESSION, false, credentials as never);

      expect(hooksRequests()).toEqual([
        { project: 'A', body: `${JSON.stringify({ type: 'agent.tool.end', session_id: SESSION, codemie_project_name: 'A' })}\n${bodyOf(a2)}` },
        { project: 'B', body: bodyOf(b1) },
      ]);
      expect(cursorAtEachHooksRequest).toEqual([0, 0]);
      await cursorsAtEof(total);
    });

    it('B fails and then succeeds on the next tick: A is sent again byte for byte, endedAt waits for the whole batch', async () => {
      const { forwardSession } = await import('../forwarder.js');
      const { readStatus } = await import('../session-status.js');
      const end = event('B', 'end', 'agent.session.end');
      await appendEvents(a1, b1, end);
      const total = Buffer.byteLength(lineOf(a1) + lineOf(b1) + lineOf(end));
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 }); // A
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503 }); // B

      await forwardSession(SESSION, true, credentials as never);

      let status = await readStatus(SESSION);
      expect(status?.cursors.hooks).toBe(0);
      expect(status?.endedAt).toBeUndefined();

      await forwardSession(SESSION, true, credentials as never);

      const requests = hooksRequests();
      expect(requests).toHaveLength(4);
      expect(requests[0]).toEqual({ project: 'A', body: bodyOf(a1) });
      expect(requests[1]).toEqual({ project: 'B', body: bodyOf(b1, end) });
      expect(requests[2]).toEqual(requests[0]);
      expect(requests[3]).toEqual(requests[1]);
      status = await readStatus(SESSION);
      expect(status?.cursors.hooks).toBe(total);
      expect(status?.endedAt).toEqual(expect.any(Number));
    });

    it('a rejected credential in the second group leaves the cursor and does not end the session', async () => {
      const { forwardSession } = await import('../forwarder.js');
      const { readStatus } = await import('../session-status.js');
      await appendEvents(a1, event('B', 'end', 'agent.session.end'));
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
      fetchMock.mockResolvedValue({ ok: false, status: 401 });

      await forwardSession(SESSION, true, credentials as never);

      const status = await readStatus(SESSION);
      expect(status?.cursors.hooks).toBe(0);
      expect(status?.endedAt).toBeUndefined();
    });

    it('events without a project name travel in the bound project request, in file order', async () => {
      const { forwardSession } = await import('../forwarder.js');
      const unnamed = event(undefined, 'u1');
      const lower = event('a', 'a-lower');
      await appendEvents(a1, b1, unnamed, lower);

      await forwardSession(SESSION, true, credentials as never);

      expect(hooksRequests()).toEqual([
        { project: 'A', body: bodyOf(a1, unnamed, lower) }, // 'a' shares A's group and is not rewritten
        { project: 'B', body: bodyOf(b1) },
      ]);
      expect(await hooksCursor()).toBe(Buffer.byteLength(lineOf(a1) + lineOf(b1) + lineOf(unnamed) + lineOf(lower)));
    });

    it('a sealed prefix is still one filtered request, even with another sendable project inside it', async () => {
      const seedConflict = await conflictSeeder();
      const { forwardSession } = await import('../forwarder.js');
      await appendEvents(a1, b1);
      const conflict = event('Bé', 'conflict');
      await seedConflict(lineOf(conflict)); // a stored conflict seals the prefix before the line

      await forwardSession(SESSION, true, credentials as never);
      await forwardSession(SESSION, true, credentials as never);

      expect(hooksRequests()).toEqual([{ project: 'A', body: bodyOf(a1) }]);
      // The second pass drains the conflicting record that follows the sealed prefix.
      expect(await hooksCursor()).toBe(Buffer.byteLength(lineOf(a1) + lineOf(b1) + lineOf(conflict)));
    });

    it('a bound session keeps flowing when unsendable names appear: only their groups are dropped', async () => {
      const { forwardSession } = await import('../forwarder.js');
      const { readStatus } = await import('../session-status.js');
      await seedBoundA(); // hooks A + OTLP streams pending
      const unsendable = event('Bé', 'u1');
      const a2 = event('A', 'a2');
      const padded = event(' A', 'p1'); // its own dropped group, not trimmed into A's
      await appendEvents(unsendable, a2, padded);
      const total = Buffer.byteLength(hookLine('A') + lineOf(unsendable) + lineOf(a2) + lineOf(padded));

      await forwardSession(SESSION, false, credentials as never);

      const aHook = `${JSON.stringify({ type: 'agent.tool.end', session_id: SESSION, codemie_project_name: 'A' })}\n`;
      expect(hooksRequests()).toEqual([{ project: 'A', body: `${aHook}${bodyOf(a2)}` }]);
      const otlp = fetchMock.mock.calls.filter(([url]) => !String(url).includes('event-hooks'));
      expect(otlp.map(([, init]) => init.headers['X-CodeMie-Project'])).toEqual(['A', 'A', 'A']);
      expect(otlp.map(([, init]) => Buffer.from(init.body).toString())).toEqual(['L', 'MM', 'TTT']);
      expect(fetchMock.mock.calls.some(([, init]) => /B\u00e9|"\sA"/.test(String(init.body)))).toBe(false);
      const status = await readStatus(SESSION);
      expect(status?.project).toBe('A');
      expect(status?.projectConflict).toBeUndefined();
      await cursorsAtEof(total);
    });

    it('OTLP streams keep the bound project header and their exact bytes for a multi-project session', async () => {
      const { forwardSession } = await import('../forwarder.js');
      await seedBoundA();
      await appendEvents(b1);

      await forwardSession(SESSION, false, credentials as never);

      const otlp = fetchMock.mock.calls.filter(([url]) => !String(url).includes('event-hooks'));
      expect(otlp.map(([, init]) => init.headers['X-CodeMie-Project'])).toEqual(['A', 'A', 'A']);
      expect(otlp.map(([, init]) => Buffer.from(init.body).toString())).toEqual(['L', 'MM', 'TTT']);
      expect(hooksRequests().map((r) => r.project)).toEqual(['A', 'B']);
    });
  });
});
