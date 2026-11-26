/**
 * Copilot CLI session discovery unit tests.
 *
 * Discovery reads only workspace.yaml — never the transcript — and must skip session
 * directories that carry no events.jsonl (pre-schema sessions with nothing to parse).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotCliSessionAdapter } from '../copilot-cli.session.js';
import { CopilotCliPluginMetadata } from '../copilot-cli.plugin.js';
import { isNativeIdSegment } from '../copilot-cli.transcript-lookup.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync), readFileSync: vi.fn(actual.readFileSync) };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

let home: string;
const DAY = 24 * 60 * 60 * 1000;

function makeSession(
  id: string,
  createdAt: number,
  opts: { withEvents?: boolean; cwd?: string; clientName?: string } = {}
): void {
  const { withEvents = true, cwd = '/repo/app', clientName } = opts;
  const dir = join(home, 'session-state', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'workspace.yaml'),
    [
      `id: ${id}`,
      `cwd: ${cwd}`,
      `git_root: ${cwd}`,
      'branch: main',
      ...(clientName ? [`client_name: ${clientName}`] : []),
      `created_at: ${new Date(createdAt).toISOString()}`,
      `updated_at: ${new Date(createdAt + 1000).toISOString()}`,
    ].join('\n')
  );
  if (withEvents) {
    writeFileSync(join(dir, 'events.jsonl'), '{"type":"session.start","data":{}}\n');
  }
}

function newAdapter(): CopilotCliSessionAdapter {
  return new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'copilot-home-'));
  process.env.COPILOT_HOME = home;
});

afterEach(() => {
  delete process.env.COPILOT_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('CopilotCliSessionAdapter.discoverSessions', () => {
  it('returns [] when session-state does not exist', async () => {
    expect(await newAdapter().discoverSessions()).toEqual([]);
  });

  it('honors COPILOT_HOME and points filePath at events.jsonl', async () => {
    makeSession('aaa', Date.now() - DAY);

    const found = await newAdapter().discoverSessions();

    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe('aaa');
    expect(found[0].filePath).toBe(join(home, 'session-state', 'aaa', 'events.jsonl'));
    expect(found[0].projectPath).toBe('/repo/app');
    expect(found[0].agentName).toBe('copilot-cli');
    expect(found[0].updatedAt).toBeGreaterThan(found[0].createdAt);
  });

  it('labels sessions by host: github/autopilot is copilot-desktop, others copilot-cli', async () => {
    const now = Date.now();
    makeSession('desktop', now - DAY, { clientName: 'github/autopilot' });
    makeSession('vscode', now - DAY, { clientName: 'vscode-agent-host' });
    makeSession('cli', now - DAY, { clientName: 'github/cli' });

    const byId = Object.fromEntries((await newAdapter().discoverSessions()).map((d) => [d.sessionId, d.agentName]));

    expect(byId).toEqual({ desktop: 'copilot-desktop', vscode: 'copilot-cli', cli: 'copilot-cli' });
  });

  it('skips session dirs with no events.jsonl', async () => {
    const now = Date.now();
    makeSession('has-events', now - DAY, { withEvents: true });
    makeSession('no-events', now - DAY, { withEvents: false });

    const found = await newAdapter().discoverSessions();

    expect(found.map((d) => d.sessionId)).toEqual(['has-events']);
  });

  it('honors maxAgeDays', async () => {
    const now = Date.now();
    makeSession('recent', now - 2 * DAY);
    makeSession('ancient', now - 90 * DAY);

    const found = await newAdapter().discoverSessions({ maxAgeDays: 30 });

    expect(found.map((d) => d.sessionId)).toEqual(['recent']);
  });

  it('defaults to a 30-day window', async () => {
    const now = Date.now();
    makeSession('inside', now - 10 * DAY);
    makeSession('outside', now - 45 * DAY);

    const found = await newAdapter().discoverSessions();

    expect(found.map((d) => d.sessionId)).toEqual(['inside']);
  });

  it('sorts newest-first and applies limit', async () => {
    const now = Date.now();
    makeSession('older', now - 5 * DAY);
    makeSession('newer', now - 1 * DAY);
    makeSession('middle', now - 3 * DAY);

    const adapter = newAdapter();

    expect((await adapter.discoverSessions()).map((d) => d.sessionId)).toEqual([
      'newer',
      'middle',
      'older',
    ]);
    expect((await adapter.discoverSessions({ limit: 2 })).map((d) => d.sessionId)).toEqual([
      'newer',
      'middle',
    ]);
  });

  it('filters by cwd when supplied, ignoring trailing slashes', async () => {
    const now = Date.now();
    makeSession('match', now - DAY, { cwd: '/repo/app' });
    makeSession('other', now - DAY, { cwd: '/somewhere/else' });

    const found = await newAdapter().discoverSessions({ cwd: '/repo/app/' });

    expect(found.map((d) => d.sessionId)).toEqual(['match']);
  });

  it('skips a session whose manifest is unreadable', async () => {
    const now = Date.now();
    makeSession('good', now - DAY);
    const broken = join(home, 'session-state', 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'workspace.yaml'), 'id: [unclosed\n  : :');
    writeFileSync(join(broken, 'events.jsonl'), '{}\n');

    const found = await newAdapter().discoverSessions();

    expect(found.map((d) => d.sessionId)).toEqual(['good']);
  });

  it('excludes timestampless sessions unless asked for them', async () => {
    const dir = join(home, 'session-state', 'no-time');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workspace.yaml'), 'id: no-time\ncwd: /repo/app\n');
    writeFileSync(join(dir, 'events.jsonl'), '{}\n');

    expect(await newAdapter().discoverSessions()).toEqual([]);

    const included = await newAdapter().discoverSessions({ includeTimestampless: true });
    expect(included.map((d) => d.sessionId)).toEqual(['no-time']);
  });
});

describe('CopilotCliSessionAdapter.locateTranscript', () => {
  const startTime = Date.parse('2026-10-01T10:00:00Z');
  const previousCodemieHome = process.env.CODEMIE_HOME;

  beforeEach(() => {
    process.env.CODEMIE_HOME = join(home, 'codemie');
    mkdirSync(join(home, 'codemie', 'sessions'), { recursive: true });
  });

  afterEach(() => {
    if (previousCodemieHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = previousCodemieHome;
  });

  function record(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      agentName: 'copilot-cli',
      provider: 'ai-run-sso',
      startTime,
      workingDirectory: home,
      status: 'active' as const,
      activeDurationMs: 0,
      correlation: { status: 'matched' as const, retryCount: 0, agentSessionId: 'aaaaaaaa-0000-4000-8000-000000000001' },
      ...overrides,
    };
  }

  function writeEvents(id: string, events: unknown[]): string {
    const dir = join(home, 'session-state', id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'events.jsonl');
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return path;
  }

  it('finds a pinned run by its CodeMie id', async () => {
    const path = writeEvents('aaaaaaaa-0000-4000-8000-000000000001', [{ type: 'session.start', timestamp: '2026-10-01T10:00:01Z' }]);

    expect(await newAdapter().locateTranscript(record())).toEqual([path]);
  });

  it('finds a --resume run by the native id it stored', async () => {
    const path = writeEvents('resumed-native-id', [{ type: 'session.start', timestamp: '2026-09-30T08:00:00Z' }]);

    expect(await newAdapter().locateTranscript(record({
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'resumed-native-id' },
    }))).toEqual([path]);
  });

  it.each(['abcdef01-2345-4678-89ab-cdef01234567', 'abcdef012345'])('finds a run by the stored native id %s', async (stored) => {
    const path = writeEvents(stored, [{ type: 'session.start', timestamp: '2026-09-30T08:00:00Z' }]);

    expect(await newAdapter().locateTranscript(record({
      correlation: { status: 'matched', retryCount: 0, agentSessionId: stored },
    }))).toEqual([path]);
  });

  it.each(['..', '../x', '.'])('does not return the file outside the session-state root that the stored id %s resolves to', async (stored) => {
    writeEvents(stored, [{ type: 'session.start', timestamp: '2026-10-01T10:00:02Z', data: { context: { cwd: home } } }]);

    expect(await newAdapter().locateTranscript(record({
      correlation: { status: 'matched', retryCount: 0, agentSessionId: stored },
    }))).toEqual([]);
  });

  it.each([undefined, '', 'unknown', '.', '..', '../x', '..\\x', 'a/b', 'a\\b'])('the stored id %j cannot name a session directory', (stored) => {
    expect(isNativeIdSegment(stored)).toBe(false);
  });

  it.each(['abcdef01-2345-4678-89ab-cdef01234567', 'abcdef012345', 'resumed-native-id'])('the stored id %s can name a session directory', (stored) => {
    expect(isNativeIdSegment(stored)).toBe(true);
  });

  it('otherwise picks the latest session started or resumed after the run start in its directory', async () => {
    const before = writeEvents('started-before', [
      { type: 'session.start', timestamp: '2026-10-01T09:59:00Z', data: { context: { cwd: home } } },
    ]);
    const elsewhere = writeEvents('other-dir', [
      { type: 'session.start', timestamp: '2026-10-01T10:05:00Z', data: { context: { cwd: '/somewhere/else' } } },
    ]);
    const first = writeEvents('first-after', [
      { type: 'session.start', timestamp: '2026-10-01T10:00:02Z', data: { context: { cwd: home } } },
    ]);
    const latest = writeEvents('resumed-after', [
      { type: 'session.start', timestamp: '2026-09-01T10:00:00Z', data: { context: { cwd: home } } },
      { type: 'session.resume', timestamp: '2026-10-01T10:00:09Z', data: { context: { cwd: home } } },
    ]);

    const located = await newAdapter().locateTranscript(record({
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'unknown' },
    }));

    expect(located).toEqual([latest]);
    expect([before, elsewhere, first]).not.toContain(located[0]);
  });

  it('a --resume <id prefix> run takes the session the prefix names, not a later standalone one in its directory', async () => {
    const prefixed = writeEvents('abcd1234-5678-4abc-8def-000000000001', [
      { type: 'session.start', timestamp: '2026-09-01T10:00:00Z', data: { context: { cwd: home } } },
      { type: 'session.resume', timestamp: '2026-10-01T10:00:02Z', data: { context: { cwd: home } } },
    ]);
    writeEvents('ffff0000-5678-4abc-8def-000000000002', [
      { type: 'session.start', timestamp: '2026-10-01T10:00:09Z', data: { context: { cwd: home } } },
    ]);

    expect(await newAdapter().locateTranscript(record({ resumeSessionId: 'ABCD1234' }))).toEqual([prefixed]);
  });

  it('a --resume <prefix> that names no session is located by the window, as a session name', async () => {
    const windowed = writeEvents('ffff0000-5678-4abc-8def-000000000003', [
      { type: 'session.start', timestamp: '2026-10-01T10:00:05Z', data: { context: { cwd: home } } },
    ]);

    expect(await newAdapter().locateTranscript(record({ resumeSessionId: 'cafe' }))).toEqual([windowed]);
  });

  it('a --resume <prefix> whose prefixed sessions are all outside the window is located by the window over every session', async () => {
    writeEvents('cafe1234-5678-4abc-8def-000000000004', [
      { type: 'session.start', timestamp: '2026-09-01T10:00:00Z', data: { context: { cwd: home } } },
    ]);
    const windowed = writeEvents('ffff0000-5678-4abc-8def-000000000005', [
      { type: 'session.start', timestamp: '2026-10-01T10:00:05Z', data: { context: { cwd: home } } },
    ]);

    expect(await newAdapter().locateTranscript(record({ resumeSessionId: 'cafe' }))).toEqual([windowed]);
  });

  it('never picks a session started at or after the start of a later copilot record in the same directory', async () => {
    const killed = record({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'unknown' } });
    const later = record({
      sessionId: 'aaaaaaaa-0000-4000-8000-000000000002',
      startTime: Date.parse('2026-10-01T10:30:00Z'),
      correlation: { status: 'matched', retryCount: 0, agentSessionId: 'unknown' },
    });
    writeFileSync(join(home, 'codemie', 'sessions', `${later.sessionId}.json`), JSON.stringify(later));
    const own = writeEvents('killed-run', [
      { type: 'session.start', timestamp: '2026-10-01T10:00:02Z', data: { context: { cwd: home } } },
    ]);
    writeEvents('later-run', [
      { type: 'session.start', timestamp: '2026-10-01T10:30:01Z', data: { context: { cwd: home } } },
    ]);

    expect(await newAdapter().locateTranscript(killed)).toEqual([own]);
  });

  describe('a lookup that could not conclude is not "none"', () => {
    const canDeny = process.platform !== 'win32' && process.getuid?.() !== 0;
    const inWindow = { type: 'session.start', timestamp: '2026-10-01T10:00:02Z' };
    const searched = () => record({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'unknown' } });

    async function withMode<T>(path: string, mode: number, work: () => Promise<T>): Promise<T> {
      chmodSync(path, mode);
      try {
        return await work();
      } finally {
        chmodSync(path, 0o755);
      }
    }

    it.skipIf(!canDeny)('an unreadable root throws; its entries can be statted but not listed', async () => {
      writeEvents('some-session', [inWindow]);
      const root = join(home, 'session-state');

      await withMode(root, 0o300, () => expect(newAdapter().locateTranscript(searched())).rejects.toMatchObject({ code: 'EACCES' }));
    });

    it.skipIf(!canDeny)('an unreadable events.jsonl in a search that matches nothing throws', async () => {
      const path = writeEvents('some-session', [{ ...inWindow, data: { context: { cwd: home } } }]);
      writeEvents('other-dir', [{ ...inWindow, data: { context: { cwd: '/somewhere/else' } } }]);

      await withMode(path, 0o000, () => expect(newAdapter().locateTranscript(searched())).rejects.toMatchObject({ code: 'EACCES' }));
    });

    it.skipIf(!canDeny)('an events.jsonl the search cannot stat throws', async () => {
      writeEvents('some-session', [inWindow]);
      const dir = join(home, 'session-state', 'some-session');

      await withMode(dir, 0o000, () => expect(newAdapter().locateTranscript(searched())).rejects.toMatchObject({ code: 'EACCES' }));
    });

    it.skipIf(!canDeny)('the direct check of a named native session throws where existsSync would say absent', async () => {
      writeEvents('resumed-native-id', [inWindow]);
      const dir = join(home, 'session-state', 'resumed-native-id');

      await withMode(dir, 0o000, () => expect(newAdapter().locateTranscript(record({
        correlation: { status: 'matched', retryCount: 0, agentSessionId: 'resumed-native-id' },
      }))).rejects.toMatchObject({ code: 'EACCES' }));
    });

    it('a missing root under the process environment is none, also when that home is missing', async () => {
      expect(await newAdapter().locateTranscript(searched())).toEqual([]);

      process.env.COPILOT_HOME = join(home, 'no-such-home');
      expect(await newAdapter().locateTranscript(searched())).toEqual([]);
    });

    it('a root that is a file is none', async () => {
      writeFileSync(join(home, 'session-state'), '');

      expect(await newAdapter().locateTranscript(searched())).toEqual([]);
    });

    it('a session directory with no events.jsonl is none, and a located sibling is still found', async () => {
      mkdirSync(join(home, 'session-state', 'aaaa-pre-schema'), { recursive: true });
      expect(await newAdapter().locateTranscript(searched())).toEqual([]);

      const sibling = writeEvents('zzzz-sibling', [{ ...inWindow, data: { context: { cwd: home } } }]);

      expect(await newAdapter().locateTranscript(searched())).toEqual([sibling]);
    });

    it('a torn last line in a readable file does not throw', async () => {
      const path = writeEvents('torn-session', [{ ...inWindow, data: { context: { cwd: home } } }]);
      writeFileSync(path, '{"type":"session.resu', { flag: 'a' });

      expect(await newAdapter().locateTranscript(searched())).toEqual([path]);
    });

    describe('a session it cannot read', () => {
      const ran = (cwd: string) => ({ ...inWindow, data: { context: { cwd } } });

      /** The next listing of the root in name order, so that the first name is scanned first. */
      function listedInNameOrder(direction: 1 | -1): void {
        vi.mocked(readdirSync).mockImplementationOnce(((root: string, options: { withFileTypes: true }) =>
          actualFs.readdirSync(root, options).sort((a, b) => direction * a.name.localeCompare(b.name))) as never);
      }

      /** A session whose `events.jsonl` is a directory: it can be statted, and reading it fails with `EISDIR`. */
      function eventsIsDirectory(id: string): void {
        mkdirSync(join(home, 'session-state', id, 'events.jsonl'), { recursive: true });
      }

      it.skipIf(!canDeny).each([
        ['before', 1],
        ['after', -1],
      ] as const)('a mode 000 neighbour scanned %s the match: throws', async (_order, direction) => {
        const neighbour = writeEvents('aaaa-neighbour', [ran(home)]);
        writeEvents('zzzz-match', [ran(home)]);
        listedInNameOrder(direction);

        await withMode(neighbour, 0o000, () => expect(newAdapter().locateTranscript(searched())).rejects.toMatchObject({ code: 'EACCES' }));
      });

      it.each([
        ['before', 1],
        ['after', -1],
      ] as const)('an EISDIR neighbour scanned %s the match: throws', async (_order, direction) => {
        eventsIsDirectory('aaaa-neighbour');
        writeEvents('zzzz-match', [ran(home)]);
        listedInNameOrder(direction);

        await expect(newAdapter().locateTranscript(searched())).rejects.toMatchObject({ code: 'EISDIR' });
      });

      it.skipIf(!canDeny).each([
        ['before', 1],
        ['after', -1],
      ] as const)('a neighbour it cannot stat scanned %s the match: the match', async (_order, direction) => {
        writeEvents('aaaa-neighbour', [ran(home)]);
        const match = writeEvents('zzzz-match', [ran(home)]);
        listedInNameOrder(direction);

        expect(await withMode(join(home, 'session-state', 'aaaa-neighbour'), 0o000, () => newAdapter().locateTranscript(searched()))).toEqual([match]);
      });

      it('a neighbour last written before the run started does not block the match', async () => {
        eventsIsDirectory('aaaa-neighbour');
        const old = new Date(startTime - 60_000);
        utimesSync(join(home, 'session-state', 'aaaa-neighbour', 'events.jsonl'), old, old);
        const match = writeEvents('zzzz-match', [ran(home)]);
        listedInNameOrder(1);

        expect(await newAdapter().locateTranscript(searched())).toEqual([match]);
      });

      it('an EISDIR neighbour and no match throws', async () => {
        eventsIsDirectory('aaaa-neighbour');
        writeEvents('zzzz-other-dir', [ran('/somewhere/else')]);

        await expect(newAdapter().locateTranscript(searched())).rejects.toMatchObject({ code: 'EISDIR' });
      });

      describe('a neighbour too long to read into a string', () => {
        let tooLong: string;

        beforeEach(() => {
          tooLong = writeEvents('aaaa-too-long', [ran(home)]);
          vi.mocked(readFileSync).mockImplementation(((path: string, options: BufferEncoding) => {
            if (path === tooLong) throw Object.assign(new Error('too long'), { code: 'ERR_STRING_TOO_LONG' });
            return actualFs.readFileSync(path, options);
          }) as never);
        });

        afterEach(() => {
          vi.mocked(readFileSync).mockImplementation(actualFs.readFileSync);
        });

        it('with a match: throws', async () => {
          writeEvents('zzzz-match', [ran(home)]);
          listedInNameOrder(1);

          await expect(newAdapter().locateTranscript(searched())).rejects.toMatchObject({ code: 'ERR_STRING_TOO_LONG' });
        });

        it('with no match: throws', async () => {
          await expect(newAdapter().locateTranscript(searched())).rejects.toMatchObject({ code: 'ERR_STRING_TOO_LONG' });
        });
      });

      it('an unreadable session of the prefix and a match outside it: throws, no fallback', async () => {
        eventsIsDirectory('cafe1234-5678-4abc-8def-000000000001');
        writeEvents('ffff0000-5678-4abc-8def-000000000002', [ran(home)]);

        await expect(newAdapter().locateTranscript(record({ resumeSessionId: 'cafe' }))).rejects.toMatchObject({ code: 'EISDIR' });
      });

      it.skipIf(!canDeny)('a session of the prefix it cannot stat and a match outside it: throws, no fallback', async () => {
        const named = 'cafe1234-5678-4abc-8def-000000000001';
        writeEvents(named, [ran(home)]);
        writeEvents('ffff0000-5678-4abc-8def-000000000002', [ran(home)]);

        await withMode(join(home, 'session-state', named), 0o000, () =>
          expect(newAdapter().locateTranscript(record({ resumeSessionId: 'cafe' }))).rejects.toMatchObject({ code: 'EACCES' }));
      });

      it.skipIf(!canDeny)('a session of the prefix it cannot stat and a match in the prefix: the match', async () => {
        const denied = 'cafe1234-5678-4abc-8def-000000000001';
        writeEvents(denied, [ran(home)]);
        const match = writeEvents('cafe9999-5678-4abc-8def-000000000002', [ran(home)]);

        expect(await withMode(join(home, 'session-state', denied), 0o000, () =>
          newAdapter().locateTranscript(record({ resumeSessionId: 'cafe' })))).toEqual([match]);
      });

      it('an unreadable session of the prefix and no match anywhere throws', async () => {
        eventsIsDirectory('cafe1234-5678-4abc-8def-000000000001');

        await expect(newAdapter().locateTranscript(record({ resumeSessionId: 'cafe' }))).rejects.toMatchObject({ code: 'EISDIR' });
      });

      it.skipIf(!canDeny)('an in-window start whose cwd cannot be resolved throws, with a match elsewhere too', async () => {
        const locked = join(home, 'locked');
        mkdirSync(join(locked, 'run'), { recursive: true });
        writeEvents('aaaa-neighbour', [ran(join(locked, 'run'))]);

        await withMode(locked, 0o000, () => expect(newAdapter().locateTranscript(searched())).rejects.toMatchObject({ code: 'EACCES' }));

        writeEvents('zzzz-match', [ran(home)]);
        listedInNameOrder(1);
        await withMode(locked, 0o000, () => expect(newAdapter().locateTranscript(searched())).rejects.toMatchObject({ code: 'EACCES' }));
      });

      it.skipIf(!canDeny)('a start before the run whose cwd cannot be resolved does not block the match', async () => {
        const locked = join(home, 'locked');
        mkdirSync(join(locked, 'run'), { recursive: true });
        writeEvents('aaaa-neighbour', [{ ...ran(join(locked, 'run')), timestamp: '2026-09-30T10:00:00Z' }]);
        const match = writeEvents('zzzz-match', [ran(home)]);
        listedInNameOrder(1);

        expect(await withMode(locked, 0o000, () => newAdapter().locateTranscript(searched()))).toEqual([match]);
      });
    });

    describe('the run\'s directory', () => {
      it.skipIf(!canDeny)('that cannot be resolved throws, though a session names the same path', async () => {
        const locked = join(home, 'locked');
        const runDir = join(locked, 'run');
        mkdirSync(runDir, { recursive: true });
        writeEvents('same-path', [{ ...inWindow, data: { context: { cwd: runDir } } }]);

        await withMode(locked, 0o000, () => expect(newAdapter().locateTranscript(record({ workingDirectory: runDir }))).rejects.toMatchObject({ code: 'EACCES' }));
      });

      it('that was deleted still compares as itself', async () => {
        const deleted = join(home, 'deleted-run');
        const match = writeEvents('some-session', [{ ...inWindow, data: { context: { cwd: deleted } } }]);

        expect(await newAdapter().locateTranscript(record({ workingDirectory: deleted }))).toEqual([match]);
      });
    });

    describe('a pinned or resumed transcript with no read permission', () => {
      it.skipIf(!canDeny)('pinned throws', async () => {
        const pinned = record();
        const path = writeEvents(pinned.sessionId, [inWindow]);

        await withMode(path, 0o000, () => expect(newAdapter().locateTranscript(pinned)).rejects.toMatchObject({ code: 'EACCES' }));
      });

      it.skipIf(!canDeny)('resumed throws', async () => {
        const path = writeEvents('resumed-native-id', [inWindow]);
        const resumed = record({ correlation: { status: 'matched', retryCount: 0, agentSessionId: 'resumed-native-id' } });

        await withMode(path, 0o000, () => expect(newAdapter().locateTranscript(resumed)).rejects.toMatchObject({ code: 'EACCES' }));
      });
    });
  });

  describe('the home it searches', () => {
    const native = 'resumed-native-id';
    const resumed = { correlation: { status: 'matched', retryCount: 0, agentSessionId: native } };

    function writeUnder(copilotHome: string): string {
      const dir = join(copilotHome, 'session-state', native);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'), '{}\n');
      return join(dir, 'events.jsonl');
    }

    it('is the record\'s agentHome, not the process environment\'s', async () => {
      writeUnder(home);
      const agentHome = join(home, 'run-home');
      const expected = writeUnder(agentHome);

      expect(await newAdapter().locateTranscript(record({ ...resumed, agentHome }))).toEqual([expected]);
    });

    it('is the process environment\'s for a record without agentHome', async () => {
      const expected = writeUnder(home);
      writeUnder(join(home, 'run-home'));

      expect(await newAdapter().locateTranscript(record(resumed))).toEqual([expected]);
    });

    it('a stored home that is gone throws, though the process environment\'s home holds the session', async () => {
      writeUnder(home);

      await expect(newAdapter().locateTranscript(record({ ...resumed, agentHome: join(home, 'unmounted') }))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('a stored home that is a file throws', async () => {
      const agentHome = join(home, 'a-file');
      writeFileSync(agentHome, '');

      await expect(newAdapter().locateTranscript(record({ ...resumed, agentHome }))).rejects.toMatchObject({ code: expect.stringMatching(/^(ENOTDIR|ENOENT)$/) }); // Windows reports a file on the path as ENOENT
    });

    it('a stored home that exists with no session-state throws', async () => {
      const agentHome = join(home, 'fresh-home');
      mkdirSync(agentHome);

      await expect(newAdapter().locateTranscript(record({ ...resumed, agentHome }))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('a stored home with an empty session-state and no match is none', async () => {
      const agentHome = join(home, 'fresh-home');
      mkdirSync(join(agentHome, 'session-state'), { recursive: true });

      expect(await newAdapter().locateTranscript(record({ ...resumed, agentHome }))).toEqual([]);
    });
  });
});
