import { lstat, mkdtemp, readFile, stat, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writePrivateJson, writePrivateText } from '../private-file.js';

describe('writePrivateJson', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'private-file-test-'));
    path = join(dir, 'nested', 'secret.json');
  });

  afterEach(async () => {
    const { rm } = await import('fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the given data as pretty-printed JSON, creating the parent directory', async () => {
    await writePrivateJson(path, { hello: 'world' });

    await expect(readFile(path, 'utf-8')).resolves.toBe(JSON.stringify({ hello: 'world' }, null, 2));
  });

  it('writes the file with mode 0600', async () => {
    await writePrivateJson(path, { a: 1 });

    if (process.platform !== 'win32') {
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('fixes permissions on a pre-existing wider-mode file after a write', async () => {
    const flatPath = join(dir, 'flat.json');
    await writeFile(flatPath, '{}', 'utf-8');
    const { chmod } = await import('fs/promises');
    await chmod(flatPath, 0o644);

    await writePrivateJson(flatPath, { b: 2 });

    if (process.platform !== 'win32') {
      const mode = (await stat(flatPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it.skipIf(process.platform === 'win32')('writes through a symlinked settings path: the link kept, its target holding the new text at 0600', async () => {
    const targetPath = join(dir, 'real-settings.json');
    const linkPath = join(dir, 'settings.json');
    await writeFile(targetPath, 'old', 'utf-8');
    const { chmod } = await import('fs/promises');
    await chmod(targetPath, 0o644);
    await symlink(targetPath, linkPath);

    await writePrivateText(linkPath, 'new text');

    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(targetPath, 'utf-8')).resolves.toBe('new text');
    if (process.platform !== 'win32') {
      expect((await stat(targetPath)).mode & 0o777).toBe(0o600);
    }
  });
});
