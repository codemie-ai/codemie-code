/**
 * Migration 012 heals installed Gemini hook commands to the `.cmd` shim on Windows. EPMCDME-16975.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('012-heal-gemini-hook-cmd-shim', () => {
  let home = '';
  let shim = '';
  let originalCodemieHome: string | undefined;
  let platSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(async () => {
    vi.resetModules();
    home = await mkdtemp(join(tmpdir(), 'mig012-'));
    shim = join(home, 'npm', 'codemie').replaceAll('\\', '/');
    await mkdir(join(home, 'npm'), { recursive: true });
    await writeFile(shim, '#!/bin/sh');
    await writeFile(`${shim}.cmd`, '@echo off');
    originalCodemieHome = process.env.CODEMIE_HOME;
    process.env.CODEMIE_HOME = join(home, '.codemie');
    vi.doMock('os', async (imp) => ({ ...(await imp<typeof import('os')>()), homedir: () => home }));
    vi.doMock('../../utils/processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue('/abs/codemie') }));
    vi.doMock('../../utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    }));
    platSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });

  afterEach(async () => {
    platSpy?.mockRestore();
    vi.doUnmock('fs/promises');
    if (originalCodemieHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = originalCodemieHome;
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  const hooksJson = (command: string) =>
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } });

  async function seed(root: string[], command = `${shim} hook`): Promise<string> {
    const dir = join(home, ...root);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'hooks.json');
    await writeFile(file, hooksJson(command));
    return file;
  }

  const geminiDir = ['.gemini', 'extensions', 'codemie', 'hooks'];

  async function run() {
    const { HealGeminiHookCmdShimMigration } = await import('../012-heal-gemini-hook-cmd-shim.migration.js');
    return new HealGeminiHookCmdShimMigration().up();
  }

  it('rewrites the extensionless shim to the .cmd shim on win32, without adding a shell key', async () => {
    const file = await seed(geminiDir);
    const res = await run();
    expect(res).toMatchObject({ success: true, migrated: true });
    const hook = JSON.parse(await readFile(file, 'utf-8')).hooks.SessionStart[0].hooks[0];
    expect(hook).toEqual({ type: 'command', command: `${shim}.cmd hook` });
  });

  it('a second run reports nothing-to-rewrite and does not write', async () => {
    await seed(geminiDir);
    await run();
    vi.resetModules();
    const writeSpy = vi.fn();
    vi.doMock('fs/promises', async (imp) => ({ ...(await imp<typeof import('fs/promises')>()), writeFile: writeSpy }));
    const res = await run();
    expect(res).toMatchObject({ success: true, migrated: false, reason: 'nothing-to-rewrite' });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('succeeds when the Gemini hooks file does not exist', async () => {
    expect(await run()).toMatchObject({ success: true, migrated: false });
  });

  it('succeeds when the hooks file is unreadable JSON', async () => {
    const file = await seed(geminiDir);
    await writeFile(file, '{ not json');
    expect(await run()).toMatchObject({ success: true, migrated: false });
  });

  it('returns write-failed when the write fails with EACCES, and leaves no temp file', async () => {
    const file = await seed(geminiDir);
    vi.doMock('fs/promises', async (imp) => {
      const actual = await imp<typeof import('fs/promises')>();
      return { ...actual, writeFile: vi.fn().mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' })) };
    });
    const res = await run();
    expect(res).toMatchObject({ success: false, reason: 'write-failed' });
    expect(await readdir(join(file, '..'))).toEqual(['hooks.json']);
  });

  it('retries the rename when the file is briefly locked (EPERM), then succeeds', async () => {
    const file = await seed(geminiDir);
    const renameMock = vi.fn();
    vi.doMock('fs/promises', async (imp) => {
      const actual = await imp<typeof import('fs/promises')>();
      renameMock.mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
      renameMock.mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
      renameMock.mockImplementation(actual.rename);
      return { ...actual, rename: renameMock };
    });
    const res = await run();
    expect(res).toMatchObject({ success: true, migrated: true });
    expect(renameMock).toHaveBeenCalledTimes(3);
    expect(await readdir(join(file, '..'))).toEqual(['hooks.json']);
  });

  it.each(['EPERM', 'EBUSY'])(
    'returns write-failed after exhausting rename retries on persistent %s, leaving the original intact',
    async (code) => {
      const file = await seed(geminiDir);
      const before = await readFile(file, 'utf-8');
      const renameMock = vi.fn().mockRejectedValue(Object.assign(new Error(code), { code }));
      vi.doMock('fs/promises', async (imp) => ({ ...(await imp<typeof import('fs/promises')>()), rename: renameMock }));
      const res = await run();
      expect(res).toMatchObject({ success: false, reason: 'write-failed' });
      expect(renameMock).toHaveBeenCalledTimes(3);
      expect(await readdir(join(file, '..'))).toEqual(['hooks.json']);
      expect(await readFile(file, 'utf-8')).toBe(before);
    },
  );

  it('does not retry a non-retryable rename error (EACCES) and returns write-failed', async () => {
    const file = await seed(geminiDir);
    const before = await readFile(file, 'utf-8');
    const renameMock = vi.fn().mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    vi.doMock('fs/promises', async (imp) => ({ ...(await imp<typeof import('fs/promises')>()), rename: renameMock }));
    const res = await run();
    expect(res).toMatchObject({ success: false, reason: 'write-failed' });
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(await readdir(join(file, '..'))).toEqual(['hooks.json']);
    expect(await readFile(file, 'utf-8')).toBe(before);
  });

  it('is a no-op on non-win32', async () => {
    platSpy?.mockReturnValue('linux');
    const file = await seed(geminiDir);
    const before = await readFile(file, 'utf-8');
    expect(await run()).toMatchObject({ success: true, migrated: false });
    expect(await readFile(file, 'utf-8')).toBe(before);
  });

  it('never touches the Claude hooks file', async () => {
    const claude = await seed(['.codemie', 'claude-plugin', 'hooks']);
    const before = await readFile(claude, 'utf-8');
    await run();
    expect(await readFile(claude, 'utf-8')).toBe(before);
  });

  it('leaves no temp file after a successful write', async () => {
    const file = await seed(geminiDir);
    await run();
    expect(await readdir(join(file, '..'))).toEqual(['hooks.json']);
  });
});
