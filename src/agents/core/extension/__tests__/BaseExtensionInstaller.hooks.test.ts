/**
 * Verifies BaseExtensionInstaller localizes installed hook commands to an
 * absolute codemie path after a clean copy. Covers EPMCDME-14035 (Bug 1).
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('BaseExtensionInstaller localizes hook commands', () => {
  let src = '';
  let home = '';

  beforeEach(async () => {
    vi.resetModules();
    // getCommandPath('codemie') → fixed absolute path drives resolveCodemieBinary().
    vi.doMock('../../../../utils/processes.js', () => ({
      getCommandPath: vi.fn().mockResolvedValue('/abs/codemie'),
    }));
    src = await mkdtemp(join(tmpdir(), 'ext-src-'));
    home = await mkdtemp(join(tmpdir(), 'ext-home-'));
    await mkdir(join(src, 'hooks'), { recursive: true });
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(join(src, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '9.9.9' }));
    await writeFile(join(src, 'README.md'), '# x');
    await writeFile(
      join(src, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: 'codemie hook' },
                { type: 'command', command: 'codemie sound SessionStart' },
              ],
            },
          ],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codemie hook' }] }],
        },
      }),
    );
  });

  afterEach(async () => {
    await rm(src, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('rewrites installed hooks.json commands to the absolute path', async () => {
    const { BaseExtensionInstaller } = await import('../BaseExtensionInstaller.js');
    class TestInstaller extends (BaseExtensionInstaller as unknown as typeof BaseExtensionInstaller) {
      protected getSourcePath(): string {
        return src;
      }
      getTargetPath(): string {
        return join(home, 'ext');
      }
      protected getManifestPath(): string {
        return '.claude-plugin/plugin.json';
      }
      protected getCriticalFiles(): string[] {
        return ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'README.md'];
      }
    }

    const res = await new TestInstaller('test').install();
    expect(res.success).toBe(true);

    const installed = JSON.parse(await readFile(join(home, 'ext', 'hooks', 'hooks.json'), 'utf-8'));
    expect(installed.hooks.SessionStart[0].hooks[0].command).toBe('/abs/codemie hook');
    expect(installed.hooks.SessionStart[0].hooks[1].command).toBe('/abs/codemie sound SessionStart');
    expect(installed.hooks.UserPromptSubmit[0].hooks[0].command).toBe('/abs/codemie hook');
  });
});

describe('BaseExtensionInstaller repairs stale hook paths on already_exists', () => {
  let src = '';
  let home = '';
  let binDir = '';
  const getCommandPath = vi.fn();

  const makeInstaller = async (withHooks = true) => {
    const { BaseExtensionInstaller } = await import('../BaseExtensionInstaller.js');
    class TestInstaller extends (BaseExtensionInstaller as unknown as typeof BaseExtensionInstaller) {
      protected getSourcePath(): string {
        return src;
      }
      getTargetPath(): string {
        return join(home, 'ext');
      }
      protected getManifestPath(): string {
        return '.claude-plugin/plugin.json';
      }
      protected getCriticalFiles(): string[] {
        return withHooks
          ? ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'README.md']
          : ['.claude-plugin/plugin.json', 'README.md'];
      }
      // Kimi-style: installed-ness does not depend on hooks/hooks.json.
      protected async getInstalledInfo(): Promise<{ installed: boolean; version: string | null } | null> {
        if (withHooks) return super.getInstalledInfo();
        try {
          await readFile(join(this.getTargetPath(), '.claude-plugin', 'plugin.json'), 'utf-8');
          return { installed: true, version: '9.9.9' };
        } catch {
          return null;
        }
      }
    }
    return new TestInstaller('test');
  };

  const hooksPath = () => join(home, 'ext', 'hooks', 'hooks.json');

  const writeSourceHooks = async (extra: Array<{ type: string; command: string }> = []) => {
    await writeFile(
      join(src, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: 'codemie hook' },
                { type: 'command', command: 'codemie sound SessionStart' },
                ...extra,
              ],
            },
          ],
        },
      }),
    );
  };

  beforeEach(async () => {
    vi.resetModules();
    getCommandPath.mockReset();
    vi.doMock('../../../../utils/processes.js', () => ({ getCommandPath }));
    src = await mkdtemp(join(tmpdir(), 'ext-src-'));
    home = await mkdtemp(join(tmpdir(), 'ext-home-'));
    binDir = await mkdtemp(join(tmpdir(), 'ext-bin-'));
    await mkdir(join(src, 'hooks'), { recursive: true });
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(join(src, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '9.9.9' }));
    await writeFile(join(src, 'README.md'), '# x');
    await writeSourceHooks();
  });

  afterEach(async () => {
    vi.doUnmock('../../../../utils/logger.js');
    vi.restoreAllMocks();
    await rm(src, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  const makeBin = async (name: string): Promise<string> => {
    const dir = join(binDir, name);
    await mkdir(dir, { recursive: true });
    const p = join(dir, 'codemie');
    await writeFile(p, '#!/bin/sh\n');
    return p;
  };

  // resolveCodemieBinary writes Windows paths with forward slashes (they run through bash).
  const asHookPath = (p: string): string => p.replace(/\\/g, '/');

  it('rewrites commands pointing at a deleted codemie path to the current one', async () => {
    const a = await makeBin('a');
    const b = await makeBin('b');
    getCommandPath.mockResolvedValue(a);
    const installer = await makeInstaller();
    expect((await installer.install()).action).toBe('copied');

    await rm(a);
    getCommandPath.mockResolvedValue(b);
    expect((await installer.install()).action).toBe('already_exists');

    const installed = JSON.parse(await readFile(hooksPath(), 'utf-8'));
    const cmds = installed.hooks.SessionStart[0].hooks.map((h: { command: string }) => h.command);
    expect(cmds).toEqual([`${asHookPath(b)} hook`, `${asHookPath(b)} sound SessionStart`]);
  });

  it('does not write or look up PATH when the codemie path still exists', async () => {
    const a = await makeBin('a');
    getCommandPath.mockResolvedValue(a);
    const installer = await makeInstaller();
    await installer.install();
    const before = await readFile(hooksPath(), 'utf-8');
    const callsBefore = getCommandPath.mock.calls.length;

    expect((await installer.install()).action).toBe('already_exists');
    expect(await readFile(hooksPath(), 'utf-8')).toBe(before);
    expect(getCommandPath.mock.calls.length).toBe(callsBefore);
  });

  it('leaves stale commands unchanged when only the bare codemie fallback is available', async () => {
    const a = await makeBin('a');
    getCommandPath.mockResolvedValue(a);
    const installer = await makeInstaller();
    await installer.install();
    await rm(a);
    const before = await readFile(hooksPath(), 'utf-8');

    getCommandPath.mockRejectedValue(new Error('not found'));
    const argvSpy = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '']);
    expect((await installer.install()).action).toBe('already_exists');
    argvSpy.mockRestore();
    expect(await readFile(hooksPath(), 'utf-8')).toBe(before);
  });

  it('does not warn on every start when the extension has no hooks.json (Kimi-style)', async () => {
    const warn = vi.fn();
    vi.doMock('../../../../utils/logger.js', () => ({
      logger: { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn(), success: vi.fn() },
    }));
    await rm(join(src, 'hooks'), { recursive: true, force: true });
    const installer = await makeInstaller(false);
    expect((await installer.install()).success).toBe(true);
    warn.mockClear();
    expect((await installer.install()).action).toBe('already_exists');
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves non-codemie commands untouched alongside a stale one', async () => {
    await writeSourceHooks([
      { type: 'command', command: '/usr/bin/other hook' },
      { type: 'command', command: './codemie hook' },
    ]);
    const a = await makeBin('a');
    const b = await makeBin('b');
    getCommandPath.mockResolvedValue(a);
    const installer = await makeInstaller();
    await installer.install();
    await rm(a);
    getCommandPath.mockResolvedValue(b);
    await installer.install();

    const installed = JSON.parse(await readFile(hooksPath(), 'utf-8'));
    const cmds = installed.hooks.SessionStart[0].hooks.map((h: { command: string }) => h.command);
    expect(cmds).toEqual([`${asHookPath(b)} hook`, `${asHookPath(b)} sound SessionStart`, '/usr/bin/other hook', './codemie hook']);
  });
});
