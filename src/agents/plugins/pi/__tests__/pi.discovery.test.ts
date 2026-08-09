/**
 * Pi transcript discovery.
 *
 * `discoverSessions` is a plain listing of the transcripts visible from a project.
 * It deliberately does NOT decide which of them belong to a particular run — that
 * question is answered by the run ledger the CodeMie extension writes from inside
 * Pi. The last test in this file guards that boundary: several rounds of heuristics
 * that tried to answer it here were each shown to be reachable-wrong, and the
 * failure mode was uploading another process's session under this user's identity.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiSessionAdapter } from '../pi.session.js';
import { PiPluginMetadata } from '../pi.plugin.js';
import { getPiSessionDir } from '../pi.paths.js';
import { redirectHomeDir } from './home-redirect.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const DAY = 24 * 60 * 60 * 1000;

let sessionDir: string;
let projectDir: string;

interface TranscriptOptions {
  cwd?: string;
  ageDays?: number;
  header?: string | null;
  parentSession?: string;
}

function makeTranscript(name: string, options: TranscriptOptions = {}): string {
  const { cwd = projectDir, ageDays = 0, header, parentSession } = options;
  const path = join(sessionDir, name);

  const line =
    header === undefined
      ? JSON.stringify({
          type: 'session',
          version: 3,
          id: name.replace('.jsonl', ''),
          timestamp: new Date(Date.now() - ageDays * DAY).toISOString(),
          cwd,
          ...(parentSession && { parentSession }),
        })
      : header;

  writeFileSync(path, line === null ? '' : `${line}\n`);

  if (ageDays > 0) {
    const when = (Date.now() - ageDays * DAY) / 1000;
    utimesSync(path, when, when);
  }
  return path;
}

function discover(overrides: Record<string, unknown> = {}) {
  return new PiSessionAdapter(PiPluginMetadata).discoverSessions({
    cwd: projectDir,
    env: { PI_CODING_AGENT_SESSION_DIR: sessionDir },
    ...overrides,
  });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pi-proj-'));
  sessionDir = mkdtempSync(join(tmpdir(), 'pi-sessions-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});

describe('PiSessionAdapter.discoverSessions', () => {
  it('returns [] when the session directory does not exist', async () => {
    rmSync(sessionDir, { recursive: true, force: true });
    expect(await discover()).toEqual([]);
  });

  it('returns [] when the session directory is empty', async () => {
    expect(await discover()).toEqual([]);
  });

  it('returns a descriptor built from the transcript header', async () => {
    const path = makeTranscript('sess-a.jsonl');

    const [descriptor] = await discover();

    expect(descriptor).toMatchObject({
      sessionId: 'sess-a',
      filePath: path,
      projectPath: projectDir,
      agentName: 'pi',
    });
    expect(descriptor.createdAt).toBeTypeOf('number');
    expect(descriptor.updatedAt).toBeTypeOf('number');
  });

  it('ignores files that are not .jsonl', async () => {
    makeTranscript('sess-a.jsonl');
    writeFileSync(join(sessionDir, 'notes.txt'), 'irrelevant');
    writeFileSync(join(sessionDir, 'sess-b.json'), '{}');

    expect((await discover()).map((s) => s.sessionId)).toEqual(['sess-a']);
  });

  it('skips transcripts belonging to a different project', async () => {
    makeTranscript('mine.jsonl');
    makeTranscript('theirs.jsonl', { cwd: '/some/other/repo' });

    expect((await discover()).map((s) => s.sessionId)).toEqual(['mine']);
  });

  it.each([
    ['an empty file', null],
    ['a malformed first line', '{"type":"session",'],
    ['a non-session first line', '{"type":"message","id":"x"}'],
    ['a header with no id', '{"type":"session","timestamp":"2026-01-01T00:00:00Z","cwd":"/x"}'],
  ])('skips a transcript with %s', async (_label, header) => {
    makeTranscript('good.jsonl');
    makeTranscript('bad.jsonl', { header });

    expect((await discover()).map((s) => s.sessionId)).toEqual(['good']);
  });

  it('filters on modification time, so a long-running session is never dropped', async () => {
    makeTranscript('fresh.jsonl');
    makeTranscript('stale.jsonl', { ageDays: 40 });

    expect((await discover({ maxAgeDays: 30 })).map((s) => s.sessionId)).toEqual(['fresh']);
  });

  it('honours maxAgeDays', async () => {
    makeTranscript('recent.jsonl', { ageDays: 2 });
    makeTranscript('older.jsonl', { ageDays: 10 });

    expect((await discover({ maxAgeDays: 5 })).map((s) => s.sessionId)).toEqual(['recent']);
    expect((await discover({ maxAgeDays: 30 })).map((s) => s.sessionId).sort()).toEqual([
      'older',
      'recent',
    ]);
  });

  it('sorts newest first and applies limit', async () => {
    makeTranscript('oldest.jsonl', { ageDays: 3 });
    makeTranscript('middle.jsonl', { ageDays: 2 });
    makeTranscript('newest.jsonl', { ageDays: 1 });

    expect((await discover()).map((s) => s.sessionId)).toEqual(['newest', 'middle', 'oldest']);
    expect((await discover({ limit: 2 })).map((s) => s.sessionId)).toEqual(['newest', 'middle']);
  });

  it('reads the session directory from the environment override', async () => {
    makeTranscript('sess-a.jsonl');

    // Pointed elsewhere, discovery must find nothing rather than falling back.
    const elsewhere = mkdtempSync(join(tmpdir(), 'pi-elsewhere-'));
    const found = await new PiSessionAdapter(PiPluginMetadata).discoverSessions({
      cwd: projectDir,
      env: { PI_CODING_AGENT_SESSION_DIR: elsewhere },
    });

    rmSync(elsewhere, { recursive: true, force: true });
    expect(found).toEqual([]);
  });
});

/**
 * Scope follows the caller: a `cwd` means "this project", no `cwd` means "everything".
 * Analytics passes no cwd, and Claude/Codex discovery is global, so a Pi listing pinned to
 * `process.cwd()` reported zero usage whenever the report was run from anywhere but the
 * project directory.
 */
describe('discoverSessions — unscoped listing', () => {
  /** Pi's default layout: one directory per cwd under a shared `sessions/` root. */
  function makeProjectTranscript(sessionsRoot: string, project: string, name: string, cwd: string): void {
    const dir = join(sessionsRoot, project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, name),
      `${JSON.stringify({ type: 'session', version: 3, id: name.replace('.jsonl', ''), timestamp: new Date().toISOString(), cwd })}\n`
    );
  }

  it('lists every project when the caller names no cwd', async () => {
    const here = mkdtempSync(join(tmpdir(), 'pi-here-'));
    // The unscoped listing also reads Pi's own default root under the user's home, so the home
    // directory must be redirected or this asserts against whatever real sessions the developer
    // happens to have.
    const home = mkdtempSync(join(tmpdir(), 'pi-home-'));
    const restoreHome = redirectHomeDir(home);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(here);
    try {
      const sessionsRoot = join(getPiSessionDir(here), '..');
      makeProjectTranscript(sessionsRoot, `--${here.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`, 'mine.jsonl', here);
      makeProjectTranscript(sessionsRoot, '--other-project--', 'theirs.jsonl', '/some/other/repo');

      const found = await new PiSessionAdapter(PiPluginMetadata).discoverSessions({});

      expect(found.map((s) => s.sessionId).sort()).toEqual(['mine', 'theirs']);
      expect(found.find((s) => s.sessionId === 'theirs')?.projectPath).toBe('/some/other/repo');
    } finally {
      cwdSpy.mockRestore();
      restoreHome();
      rmSync(here, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads Pi\'s own default root, where every bare-`pi` run lands', async () => {
    // Native discovery exists to report unmanaged runs, and those never touch the CodeMie
    // agent dir — so a listing that only reads <cwd>/.pi/codemie is blind to all of them.
    const here = mkdtempSync(join(tmpdir(), 'pi-here-'));
    const home = mkdtempSync(join(tmpdir(), 'pi-home-'));
    const restoreHome = redirectHomeDir(home);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(here);
    try {
      makeProjectTranscript(join(home, '.pi', 'agent', 'sessions'), '--bare-project--', 'bare.jsonl', '/bare/repo');

      const found = await new PiSessionAdapter(PiPluginMetadata).discoverSessions({});

      expect(found.map((s) => s.sessionId)).toEqual(['bare']);
    } finally {
      cwdSpy.mockRestore();
      restoreHome();
      rmSync(here, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('still narrows to one project when the caller names a cwd', async () => {
    makeTranscript('mine.jsonl');
    makeTranscript('theirs.jsonl', { cwd: '/some/other/repo' });

    expect((await discover()).map((s) => s.sessionId)).toEqual(['mine']);
  });

  it('does not treat a custom session directory as one project among siblings', async () => {
    // `PI_CODING_AGENT_SESSION_DIR` is not part of the per-cwd layout, so its neighbours are
    // arbitrary directories with nothing to do with Pi.
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    try {
      makeTranscript('mine.jsonl', { cwd: '/some/other/repo' });
      const sibling = mkdtempSync(join(tmpdir(), 'pi-sessions-'));
      writeFileSync(
        join(sibling, 'stranger.jsonl'),
        `${JSON.stringify({ type: 'session', version: 3, id: 'stranger', timestamp: new Date().toISOString(), cwd: '/elsewhere' })}\n`
      );

      const found = await new PiSessionAdapter(PiPluginMetadata).discoverSessions({
        env: { PI_CODING_AGENT_SESSION_DIR: sessionDir },
      });

      rmSync(sibling, { recursive: true, force: true });
      expect(found.map((s) => s.sessionId)).toEqual(['mine']);
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

/**
 * Regression guard for the redesign.
 *
 * If someone reintroduces run attribution into discovery, these fail. Ownership
 * belongs to the ledger (`pi.extension.ts`); a directory listing cannot distinguish
 * this run's transcripts from a concurrent `pi`'s, and guessing leaks another
 * session's prompts and tool output into this user's metrics.
 */
describe('discovery performs no run attribution', () => {
  it('returns every in-scope transcript, not just one it believes is "ours"', async () => {
    makeTranscript('run-a.jsonl');
    makeTranscript('run-b.jsonl');
    makeTranscript('run-c.jsonl');

    expect((await discover()).map((s) => s.sessionId).sort()).toEqual(['run-a', 'run-b', 'run-c']);
  });

  it('does not filter on a session identity', async () => {
    makeTranscript('anchor.jsonl');
    makeTranscript('unrelated.jsonl');

    // A caller passing an id must not narrow the listing: discovery has no notion
    // of "this run" any more.
    const found = await discover({ agentSessionId: 'anchor' } as Record<string, unknown>);

    expect(found.map((s) => s.sessionId).sort()).toEqual(['anchor', 'unrelated']);
  });

  it('does not filter on a run start time', async () => {
    makeTranscript('before.jsonl', { ageDays: 2 });
    makeTranscript('during.jsonl');

    const found = await discover({ runStartedAt: Date.now() } as Record<string, unknown>);

    expect(found.map((s) => s.sessionId).sort()).toEqual(['before', 'during']);
  });

  it('does not treat a UUIDv4 id as evidence of a competing CodeMie run', async () => {
    // The old heuristic rejected v4 ids as "another CodeMie run"; a plain listing
    // has no opinion about who minted an id.
    makeTranscript('11111111-2222-4333-8444-555555555555.jsonl');
    makeTranscript('01931f1e-7a3c-7c9e-8b2a-0242ac120002.jsonl');

    expect(await discover()).toHaveLength(2);
  });

  it('does not follow or exclude fork lineage', async () => {
    const parent = makeTranscript('parent.jsonl');
    makeTranscript('child.jsonl', { parentSession: parent });
    makeTranscript('orphan.jsonl', { parentSession: '/somewhere/else/foreign.jsonl' });

    expect((await discover()).map((s) => s.sessionId).sort()).toEqual([
      'child',
      'orphan',
      'parent',
    ]);
  });
});
