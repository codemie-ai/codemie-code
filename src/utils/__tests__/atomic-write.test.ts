import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { writeJsonFileAtomic } from '../atomic-write.js';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** The next `times` renames fail with `code`; every later one is the real rename. */
function failRenames(code: string, times: number): void {
  for (let i = 0; i < times; i++) {
    vi.mocked(rename).mockRejectedValueOnce(errnoError(code));
  }
}

describe('writeJsonFileAtomic rename retry', () => {
  const originalPlatform = process.platform;
  let dir: string;
  let target: string;

  const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value });
  const tempFiles = () => readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  const content = () => JSON.parse(readFileSync(target, 'utf-8'));

  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), 'atomic-write-'));
    target = join(dir, 'config.json');
    writeFileSync(target, JSON.stringify({ v: 'old' }));
    vi.mocked(rename).mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('win32: a rename failing with %s twice is retried and the write lands', async (code) => {
    setPlatform('win32');
    failRenames(code, 2);

    await expect(writeJsonFileAtomic(target, { v: 'new' })).resolves.toBeUndefined();

    expect(content()).toEqual({ v: 'new' });
    expect(tempFiles()).toEqual([]);
  });

  it('win32: the tenth attempt is still made', async () => {
    setPlatform('win32');
    failRenames('EPERM', 9);

    await expect(writeJsonFileAtomic(target, { v: 'new' })).resolves.toBeUndefined();

    expect(content()).toEqual({ v: 'new' });
    expect(tempFiles()).toEqual([]);
  });

  it('win32: no eleventh attempt, the last EPERM is rethrown and the temp file removed', async () => {
    setPlatform('win32');
    failRenames('EPERM', 10);

    await expect(writeJsonFileAtomic(target, { v: 'new' })).rejects.toMatchObject({ code: 'EPERM' });

    expect(content()).toEqual({ v: 'old' });
    expect(tempFiles()).toEqual([]);
  });

  it('win32: a code outside the retry set fails on the first rename', async () => {
    setPlatform('win32');
    failRenames('ENOSPC', 1);

    await expect(writeJsonFileAtomic(target, { v: 'new' })).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(content()).toEqual({ v: 'old' });
    expect(tempFiles()).toEqual([]);
  });

  it('linux: EPERM fails on the first rename', async () => {
    setPlatform('linux');
    failRenames('EPERM', 1);

    await expect(writeJsonFileAtomic(target, { v: 'new' })).rejects.toMatchObject({ code: 'EPERM' });

    expect(content()).toEqual({ v: 'old' });
    expect(tempFiles()).toEqual([]);
  });
});
