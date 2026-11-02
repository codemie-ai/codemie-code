/**
 * File upload detection from Codex rollouts.
 *
 * Seam: `detectCodexFileUploads`. Boundaries: the home directory (a per-test temp dir) and the
 * `fs/promises` read of a rollout; rollouts are real files under the temp home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFile } from 'fs/promises';

const fakeHome = { path: '' };

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = (): string => fakeHome.path;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { detectCodexFileUploads } = await import('../codexUploadsDetector.js');

let workDir: string;
let dayDir: string;
const previousCodexHome = process.env.CODEX_HOME;

/** A rollout of a Codex session started in `cwd`, its last user turn carrying one image, modified `ageSeconds` ago. */
function writeRollout(name: string, cwd: string, ageSeconds: number): string {
  const path = join(dayDir, `rollout-${name}.jsonl`);
  const records = [
    { type: 'session_meta', payload: { id: name, cwd } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'look at this', local_images: ['/pics/shot.png'] } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }] },
    },
  ];
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  const at = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(path, at, at);
  return path;
}

beforeEach(() => {
  fakeHome.path = mkdtempSync(join(tmpdir(), 'codemie-codex-uploads-'));
  delete process.env.CODEX_HOME;
  workDir = join(fakeHome.path, 'project');
  mkdirSync(workDir);
  const now = new Date();
  dayDir = join(
    fakeHome.path, '.codex', 'sessions',
    now.getFullYear().toString(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')
  );
  mkdirSync(dayDir, { recursive: true });
});

afterEach(async () => {
  vi.mocked(readFile).mockImplementation((await vi.importActual<typeof import('fs/promises')>('fs/promises')).readFile);
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(fakeHome.path, { recursive: true, force: true });
});

describe('detectCodexFileUploads', () => {
  it('an unreadable newest rollout is skipped: the older rollout of the same cwd still yields its attachment', async () => {
    writeRollout('older', workDir, 120);
    const unreadable = writeRollout('newest', workDir, 10);
    const actualReadFile = (await vi.importActual<typeof import('fs/promises')>('fs/promises')).readFile;
    vi.mocked(readFile).mockImplementation((async (path: string, options: unknown) => {
      if (String(path) === unreadable) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return actualReadFile(path, options as Parameters<typeof actualReadFile>[1]);
    }) as typeof readFile);

    const files = await detectCodexFileUploads({ cwd: workDir, quiet: true });

    expect(files).toEqual([
      { fileName: 'shot.png', data: 'aGVsbG8=', mediaType: 'image/png', type: 'image', sizeBytes: 5 },
    ]);
  });
});
