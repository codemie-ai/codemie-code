/**
 * Unit tests for the shared codemie hook-command resolver.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('hook-command resolver', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('resolveHookCommand replaces the leading codemie token, preserving args', async () => {
    const { resolveHookCommand } = await import('../hook-command.js');
    expect(resolveHookCommand('codemie hook', '/usr/local/bin/codemie')).toBe('/usr/local/bin/codemie hook');
    expect(resolveHookCommand('codemie sound SessionStart', '/usr/local/bin/codemie')).toBe(
      '/usr/local/bin/codemie sound SessionStart',
    );
    expect(resolveHookCommand('codemie', '/usr/local/bin/codemie')).toBe('/usr/local/bin/codemie');
  });

  it('resolveHookCommand leaves non-codemie and already-absolute commands unchanged', async () => {
    const { resolveHookCommand } = await import('../hook-command.js');
    expect(resolveHookCommand('echo hi', '/usr/local/bin/codemie')).toBe('echo hi');
    expect(resolveHookCommand('/usr/local/bin/codemie hook', '/usr/local/bin/codemie')).toBe(
      '/usr/local/bin/codemie hook',
    );
  });

  it('resolveCodemieBinary prefers getCommandPath and quotes spaces', async () => {
    vi.doMock('../processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue('/opt/my apps/codemie') }));
    const { resolveCodemieBinary, resolveHookCommand } = await import('../hook-command.js');
    const bin = await resolveCodemieBinary();
    expect(bin).toBe('"/opt/my apps/codemie"');
    expect(resolveHookCommand('codemie hook', bin)).toBe('"/opt/my apps/codemie" hook');
  });

  it('resolveCodemieBinary falls back to process.argv[1] when getCommandPath is null', async () => {
    vi.doMock('../processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue(null) }));
    const spy = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '/home/u/.npm/bin/codemie']);
    const { resolveCodemieBinary } = await import('../hook-command.js');
    expect(await resolveCodemieBinary()).toBe('/home/u/.npm/bin/codemie');
    spy.mockRestore();
  });

  it('resolveCodemieBinary never throws — falls back when getCommandPath is unavailable/throws', async () => {
    // Simulates an incomplete mock or a resolver failure: must degrade, not crash.
    vi.doMock('../processes.js', () => ({}));
    const spy = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '/home/u/.npm/bin/codemie']);
    const { resolveCodemieBinary } = await import('../hook-command.js');
    await expect(resolveCodemieBinary()).resolves.toBe('/home/u/.npm/bin/codemie');
    spy.mockRestore();
  });

  it('resolveCodemieBinary: on Windows, a .js argv[1] fallback is prefixed with node and uses forward slashes', async () => {
    vi.doMock('../processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue(null) }));
    const argvSpy = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'C:\\Users\\u\\app\\codemie.js']);
    const platSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const execSpy = vi.spyOn(process, 'execPath', 'get').mockReturnValue('C:\\Program Files\\nodejs\\node.exe');
    const { resolveCodemieBinary, resolveHookCommand } = await import('../hook-command.js');
    const bin = await resolveCodemieBinary();
    // Backslashes are converted to forward slashes so bash (Git Bash / WSL) can execute the path.
    expect(bin).toBe('"C:/Program Files/nodejs/node.exe" "C:/Users/u/app/codemie.js"');
    expect(resolveHookCommand('codemie hook', bin)).toBe(
      '"C:/Program Files/nodejs/node.exe" "C:/Users/u/app/codemie.js" hook',
    );
    argvSpy.mockRestore();
    platSpy.mockRestore();
    execSpy.mockRestore();
  });

  it('resolveCodemieBinary: on Windows, getCommandPath result with backslashes is converted to forward slashes', async () => {
    vi.doMock('../processes.js', () => ({
      getCommandPath: vi.fn().mockResolvedValue('C:\\Users\\u\\AppData\\Local\\CodeMie\\bin\\codemie.cmd'),
    }));
    const platSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const { resolveCodemieBinary } = await import('../hook-command.js');
    expect(await resolveCodemieBinary()).toBe('C:/Users/u/AppData/Local/CodeMie/bin/codemie.cmd');
    platSpy.mockRestore();
  });

  it('resolveCodemieBinary: on Windows, getCommandPath result with spaces and backslashes is quoted with forward slashes', async () => {
    vi.doMock('../processes.js', () => ({
      getCommandPath: vi.fn().mockResolvedValue('C:\\Program Files\\CodeMie\\bin\\codemie.cmd'),
    }));
    const platSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const { resolveCodemieBinary } = await import('../hook-command.js');
    expect(await resolveCodemieBinary()).toBe('"C:/Program Files/CodeMie/bin/codemie.cmd"');
    platSpy.mockRestore();
  });

  describe('resolveCodemieBinary: PATH `codemie` owned by another npm package', () => {
    let root: string;

    // Lays out <root>/node_modules/<pkgName>/bin/<binFile> plus a node_modules/.bin/codemie
    // symlink to it — what npm creates for any dependency declaring `bin: { codemie }`.
    function installFakePackage(pkgName: string, binFile: string): string {
      const pkgDir = join(root, 'node_modules', ...pkgName.split('/'));
      mkdirSync(join(pkgDir, 'bin'), { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version: '0.0.0' }));
      writeFileSync(join(pkgDir, 'bin', binFile), '#!/bin/sh\n');
      // Symlinks need elevated rights on Windows; the resolved package path exercises the same check.
      if (process.platform === 'win32') return join(pkgDir, 'bin', binFile);
      const binLinkDir = join(root, 'node_modules', '.bin');
      mkdirSync(binLinkDir, { recursive: true });
      const link = join(binLinkDir, 'codemie');
      symlinkSync(join(pkgDir, 'bin', binFile), link);
      return link;
    }

    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-command-')));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('skips a shadowing `codemie` from @codemieai/codemie-opencode and falls back to argv[1]', async () => {
      const foreign = installFakePackage('@codemieai/codemie-opencode', 'codemie');
      vi.doMock('../processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue(foreign) }));
      const argvSpy = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '/home/u/.npm/bin/codemie']);
      const { resolveCodemieBinary } = await import('../hook-command.js');
      expect(await resolveCodemieBinary()).toBe('/home/u/.npm/bin/codemie');
      argvSpy.mockRestore();
    });

    it('keeps a PATH `codemie` that resolves into @codemieai/code', async () => {
      const own = installFakePackage('@codemieai/code', 'codemie.js');
      vi.doMock('../processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue(own) }));
      const { resolveCodemieBinary } = await import('../hook-command.js');
      expect(await resolveCodemieBinary()).toBe(own.replace(/\\/g, '/'));
    });
  });

  it('resolveCodemieBinary: on non-Windows, a .js argv[1] fallback stays a bare path (shebang-executable)', async () => {
    vi.doMock('../processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue(null) }));
    const argvSpy = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '/home/u/app/codemie.js']);
    const platSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { resolveCodemieBinary } = await import('../hook-command.js');
    expect(await resolveCodemieBinary()).toBe('/home/u/app/codemie.js');
    argvSpy.mockRestore();
    platSpy.mockRestore();
  });

  it('rewriteHooksCommandTree rewrites every command and reports change', async () => {
    const { rewriteHooksCommandTree } = await import('../hook-command.js');
    const hooks = {
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: 'codemie hook' },
            { type: 'command', command: 'codemie sound SessionStart' },
          ],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'codemie hook' }] }],
    };
    const changed = rewriteHooksCommandTree(hooks, '/abs/codemie');
    expect(changed).toBe(true);
    expect(hooks.SessionStart[0].hooks[0].command).toBe('/abs/codemie hook');
    expect(hooks.SessionStart[0].hooks[1].command).toBe('/abs/codemie sound SessionStart');
    expect(hooks.Stop[0].hooks[0].command).toBe('/abs/codemie hook');
  });

  it('rewriteHooksCommandTree returns false when nothing matches', async () => {
    const { rewriteHooksCommandTree } = await import('../hook-command.js');
    const hooks = { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] };
    expect(rewriteHooksCommandTree(hooks, '/abs/codemie')).toBe(false);
    expect(rewriteHooksCommandTree(null, '/abs/codemie')).toBe(false);
  });
});
