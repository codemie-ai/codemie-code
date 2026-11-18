import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { rename } from 'fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic, writeJsonFileAtomic } from '../atomic-write.js';

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

describe('writeFileAtomic', () => {
  let dir: string;
  const tempFiles = (directory: string) => readdirSync(directory).filter((name) => name.endsWith('.tmp'));

  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), 'atomic-text-'));
    vi.mocked(rename).mockReset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('writes through a link to a file: the link kept, the target holds the content, its mode kept', async () => {
    const targetDir = join(dir, 'dotfiles');
    mkdirSync(targetDir);
    const target = join(targetDir, 'settings.json');
    const link = join(dir, 'settings.json');
    writeFileSync(target, 'old');
    chmodSync(target, 0o644);
    symlinkSync(target, link);

    await writeFileAtomic(link, 'new');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('new');
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(tempFiles(dir)).toEqual([]);
    expect(tempFiles(targetDir)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('replaces the content of a regular file and keeps its mode', async () => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old');
    chmodSync(file, 0o640);

    await writeFileAtomic(file, 'new');

    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe('new');
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === 'win32')('creates a missing file in a missing directory with mode 0600', async () => {
    const file = join(dir, 'missing', 'settings.json');

    await writeFileAtomic(file, 'new');

    expect(readFileSync(file, 'utf-8')).toBe('new');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('replaces a dangling link with a regular file', async () => {
    const link = join(dir, 'settings.json');
    symlinkSync(join(dir, 'gone', 'settings.json'), link);

    await writeFileAtomic(link, 'new');

    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, 'utf-8')).toBe('new');
  });

  it.skipIf(process.platform === 'win32')('a failed rename leaves the target unchanged and no temp file beside it', async () => {
    const targetDir = join(dir, 'dotfiles');
    mkdirSync(targetDir);
    const target = join(targetDir, 'settings.json');
    const link = join(dir, 'settings.json');
    writeFileSync(target, 'old');
    symlinkSync(target, link);
    failRenames('ENOSPC', 1);

    await expect(writeFileAtomic(link, 'new')).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(readFileSync(target, 'utf-8')).toBe('old');
    expect(tempFiles(targetDir)).toEqual([]);
    expect(tempFiles(dir)).toEqual([]);
  });
});
