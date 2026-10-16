/**
 * Tests for the sqlite3 CLI fallback in the OpenCode session reader.
 *
 * `node:sqlite` only exists on Node 22.5+, and the package declares Node >= 20,
 * so on older runtimes every read goes through the `sqlite3` binary instead —
 * a production path that would otherwise ship untested. Both backends are
 * exercised here with `node:sqlite` forced unavailable and `exec` scripted, so
 * the fallback logic is verified independently of whether either tool exists on
 * the machine running the suite.
 *
 * `exec` is mocked rather than shelled out to; this asserts the reader's
 * fallback contract (inline params, JSON rows, non-zero exit as a failure), not
 * the sqlite3 binary's behaviour.
 *
 * Each case uses its own database path on purpose: the reader caches the
 * detected layout per path, so sharing one path would let an earlier case's
 * cached layout skip the schema probe the later cases depend on.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('node:sqlite', () => {
  // The reader's dynamic import must fail the way it does on Node < 22.5.
  throw new Error('node:sqlite is unavailable');
});

vi.mock('../../../../utils/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../utils/exec.js')>()),
  exec: vi.fn(),
}));

const { exec } = await import('../../../../utils/exec.js');
const mockedExec = vi.mocked(exec);

const workDir = mkdtempSync(join(tmpdir(), 'opencode-cli-'));
let dbSeq = 0;

/**
 * The reader refuses a database path that does not exist, so the scripted CLI
 * needs a real file on disk. Its contents are never parsed here — `exec` is
 * mocked — but the path must pass the existence check.
 */
function dbPath(): string {
  const p = join(workDir, `opencode-${++dbSeq}.db`);
  writeFileSync(p, '');
  return p;
}

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Build a `-json` reply the reader can parse. */
function rows(value: unknown[]): string {
  return JSON.stringify(value);
}

/** Script the schema probe to report the 2.x layout. */
function withV2Schema(impl: (sql: string) => { code: number; stdout: string; stderr: string }) {
  mockedExec.mockImplementation(async (_cmd, args) => {
    const sql = String(args?.[3] ?? '');
    if (sql.includes('sqlite_master')) {
      return { code: 0, stdout: rows([{ name: 'session_v2' }, { name: 'session_message' }]), stderr: '' };
    }
    return impl(sql);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sqlite3 CLI fallback', () => {
  it('uses an escaped exact source lookup without an age cutoff on the CLI backend', async () => {
    withV2Schema(() => ({ code: 0, stdout: rows([]), stderr: '' }));
    const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');
    await readSessionsFromDb(dbPath(), { sessionId: "ses_o'brien", maxAgeDays: 1 });
    const sql = mockedExec.mock.calls.at(-1)![1]![3];
    expect(sql).toContain("WHERE id = 'ses_o''brien'");
    expect(sql).not.toContain('time_created >=');
  });

  it('reads a v2 database through the CLI when node:sqlite is unavailable', async () => {
    withV2Schema(() => ({
      code: 0,
      stdout: rows([
        {
          id: 'ses_cli',
          project_id: 'p',
          slug: 's',
          directory: '/tmp',
          title: 'from cli',
          version: '2.0.27',
          time_created: 1,
          time_updated: 2,
        },
      ]),
      stderr: '',
    }));

    const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');
    const sessions = await readSessionsFromDb(dbPath(), { maxAgeDays: 30 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('ses_cli');
    // Read-only: the reader must never open the user's live database for writing.
    expect(mockedExec.mock.calls[0][1]).toContain('-readonly');
  });

  it('inlines bound parameters with escaped quotes', async () => {
    withV2Schema(() => ({ code: 0, stdout: rows([]), stderr: '' }));

    const { readMessagesFromDb } = await import('../opencode.sqlite-reader.js');
    await readMessagesFromDb(dbPath(), "ses_o'brien");

    // The CLI has no parameter binding, so a quote in the id must be escaped
    // rather than injected.
    const dataQuery = mockedExec.mock.calls.at(-1)?.[1] as string[];
    expect(dataQuery[3]).toContain("ses_o''brien");
  });

  it('treats empty CLI output as no rows', async () => {
    withV2Schema(() => ({ code: 0, stdout: '', stderr: '' }));

    const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');

    await expect(readSessionsFromDb(dbPath(), {})).resolves.toEqual([]);
  });

  it('reports a non-zero CLI exit during the schema probe as a failure', async () => {
    mockedExec.mockResolvedValue({ code: 1, stdout: '', stderr: 'unable to open database file' });

    const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');

    await expect(readSessionsFromDb(dbPath(), {})).rejects.toThrow(
      /Could not inspect database schema/
    );
  });

  it('reports a query failure that happens after a successful schema probe', async () => {
    withV2Schema(() => ({ code: 1, stdout: '', stderr: 'disk I/O error' }));

    const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');

    // Detection succeeded, so the failure belongs to the data query — it must
    // still surface rather than read as "no sessions".
    await expect(readSessionsFromDb(dbPath(), {})).rejects.toThrow(/Query failed/);
  });

  it('reports a thrown CLI error as a failure', async () => {
    mockedExec.mockRejectedValue(new Error('spawn sqlite3 ENOENT'));

    const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');

    await expect(readSessionsFromDb(dbPath(), {})).rejects.toThrow(
      /Could not inspect database schema/
    );
  });
});
