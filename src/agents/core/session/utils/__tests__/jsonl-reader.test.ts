/**
 * readJSONLTolerant: a malformed line is skipped, a missing file is nothing to read, any other read error fails the read.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const readFileFailure = vi.hoisted(() => ({ error: undefined as NodeJS.ErrnoException | undefined }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) =>
      readFileFailure.error ? Promise.reject(readFileFailure.error) : actual.readFile(...args),
  };
});

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const { readJSONLTolerant } = await import('../jsonl-reader.js');
const { logger } = await import('@/utils/logger.js');

describe('readJSONLTolerant', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jsonl-reader-'));
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => {
    readFileFailure.error = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips a malformed line, keeps the valid ones and warns once', async () => {
    const file = join(dir, 'cut.jsonl');
    writeFileSync(file, '{"id":1}\n{"id":2}\n{"type":"user","uuid":\n');

    await expect(readJSONLTolerant<{ id: number }>(file, '[test]')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(vi.mocked(logger.warn).mock.calls).toEqual([[`[test] Skipped 1 corrupted JSONL lines in ${file}`]]);
  });

  it('reads a missing file as empty', async () => {
    await expect(readJSONLTolerant(join(dir, 'absent.jsonl'))).resolves.toEqual([]);
  });

  it('fails with the read error when the file exists but cannot be read', async () => {
    const file = join(dir, 'locked.jsonl');
    writeFileSync(file, '{"id":1}\n');
    readFileFailure.error = Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' });

    await expect(readJSONLTolerant(file)).rejects.toBe(readFileFailure.error);
  });
});
