/** P0 F5-4: real SQL predicates and returned paths, with host/layout gates kept independent. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const sqlite = await import('node:sqlite').catch(() => ({ DatabaseSync: undefined }));
const DatabaseSync = sqlite.DatabaseSync;
const describeWithSqlite = DatabaseSync ? describe : describe.skip;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const { readSessionsFromDb } = await import('../opencode.sqlite-reader.js');
let directory: string;
let sequence = 0;

beforeAll(() => { directory = mkdtempSync(join(tmpdir(), 'opencode-p0-paths-')); });
afterEach(() => Object.defineProperty(process, 'platform', platformDescriptor));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function fixture(version: number, paths: Array<string | null>): string {
  const path = join(directory, `paths-${++sequence}.db`);
  const db = new DatabaseSync!(path);
  const table = version === 2 ? 'session_v2' : 'session';
  db.exec(`CREATE TABLE ${table} (
    id TEXT, project_id TEXT, slug TEXT, directory TEXT, title TEXT,
    version TEXT, time_created INTEGER, time_updated INTEGER
  )`);
  const insert = db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?,?,?,?,?)`);
  paths.forEach((cwd, index) => insert.run(`ses_${index}`, 'project', 'slug', cwd, 'title', `${version}.0.0`, Date.now() - index, 1));
  db.close();
  return path;
}

describeWithSqlite('F5-4 Windows v2 SQLite paths', () => {
  it.each([
    ['C:/Users/Test/project', 'C:\\Users\\Test\\project'],
    ['//Server/Share/Project', '\\\\Server\\Share\\Project'],
  ])('matches native cwd against stored %s and restores %s', async (stored, native) => {
    const path = fixture(2, [stored, '/another/project', `${stored}/`]);
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    const sessions = await readSessionsFromDb(path, { cwd: native, limit: 1 });
    expect(sessions.map(session => [session.id, session.directory])).toEqual([['ses_0', native]]);
    const all = await readSessionsFromDb(path, { cwd: native });
    expect(all.map(session => session.id)).toEqual(['ses_0', 'ses_2']);
    expect(all[1].directory).toBe(`${native}\\`);
    expect(await readSessionsFromDb(path, { cwd: native.toLowerCase() })).toEqual([]);
    expect(await readSessionsFromDb(path, { sessionId: 'ses_absent', cwd: native })).toEqual([]);
  });

  it('preserves POSIX, null and empty directories even on a Windows v2 host', async () => {
    const path = fixture(2, ['/migrated/project', '', null, 'relative/path', 'C:/project']);
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    expect((await readSessionsFromDb(path)).map(session => session.directory))
      .toEqual(['/migrated/project', '', '', 'relative/path', 'C:\\project']);
    expect(await readSessionsFromDb(path, { cwd: '' })).toHaveLength(5);
  });

  it.each([1, 2])('preserves v%s directory spelling on POSIX including literal backslashes', async version => {
    const native = 'C:\\Users\\Test\\project';
    const path = fixture(version, [native, 'C:/Users/Test/project', '/project\\literal']);
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
    expect((await readSessionsFromDb(path, { cwd: native }))[0].directory).toBe(native);
    expect((await readSessionsFromDb(path, { cwd: '/project\\literal' }))[0].directory).toBe('/project\\literal');
    expect((await readSessionsFromDb(path, { cwd: 'C:/Users/Test/project/' }))[0].directory).toBe('C:/Users/Test/project');
  });

  it('keeps the v1 layout unnormalized even on Windows', async () => {
    const native = 'C:\\Users\\Test\\project';
    const path = fixture(1, [native, 'C:/Users/Test/project']);
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    expect((await readSessionsFromDb(path, { cwd: native })).map(session => session.id)).toEqual(['ses_0']);
    expect((await readSessionsFromDb(path, { cwd: 'C:/Users/Test/project' }))[0].directory).toBe('C:/Users/Test/project');
  });
});
