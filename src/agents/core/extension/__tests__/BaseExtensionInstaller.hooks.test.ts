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

describe('BaseExtensionInstaller heals the codemie .cmd shim on win32 (EPMCDME-16975)', () => {
  const EVENTS = ['SessionStart', 'BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool', 'SessionEnd'];
  let dir = '';
  let shim = '';
  let hooksFile = '';
  let platSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../../../../utils/processes.js', () => ({ getCommandPath: vi.fn().mockResolvedValue(null) }));
    dir = await mkdtemp(join(tmpdir(), 'ext-cmd-'));
    shim = join(dir, 'bin', 'codemie').replaceAll('\\', '/');
    await mkdir(join(dir, 'bin'), { recursive: true });
    await mkdir(join(dir, 'ext', 'hooks'), { recursive: true });
    await writeFile(shim, '#!/bin/sh');
    hooksFile = join(dir, 'ext', 'hooks', 'hooks.json');
    await writeFile(hooksFile, JSON.stringify({ hooks: seedHooks() }));
  });

  afterEach(async () => {
    platSpy?.mockRestore();
    vi.doUnmock('../../../../utils/processes.js');
    await rm(dir, { recursive: true, force: true });
  });

  function seedHooks(): Record<string, unknown> {
    return Object.fromEntries(
      EVENTS.map((e) => [e, [{ hooks: [{ type: 'command', command: `${shim} hook` }] }]]),
    );
  }

  async function localize(platform: NodeJS.Platform): Promise<void> {
    platSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const { BaseExtensionInstaller } = await import('../BaseExtensionInstaller.js');
    class Probe extends (BaseExtensionInstaller as unknown as typeof BaseExtensionInstaller) {
      protected getSourcePath(): string {
        return dir;
      }
      getTargetPath(): string {
        return join(dir, 'ext');
      }
      protected getManifestPath(): string {
        return '.claude-plugin/plugin.json';
      }
      protected getCriticalFiles(): string[] {
        return [];
      }
      run(): Promise<void> {
        return this.localizeInstalledHooks(join(dir, 'ext'));
      }
    }
    await new Probe('gemini').run();
  }

  it('rewrites every Gemini hook command to the .cmd shim, with no "shell" key', async () => {
    await writeFile(`${shim}.cmd`, '@echo off');
    await localize('win32');
    const written = JSON.parse(await readFile(hooksFile, 'utf-8')) as { hooks: Record<string, any> };
    expect(Object.keys(written.hooks)).toEqual(EVENTS);
    for (const e of EVENTS) {
      expect(written.hooks[e][0].hooks[0]).toEqual({ type: 'command', command: `${shim}.cmd hook` });
    }
  });

  it('a second run leaves the file content identical', async () => {
    await writeFile(`${shim}.cmd`, '@echo off');
    await localize('win32');
    const first = await readFile(hooksFile, 'utf-8');
    await localize('win32');
    expect(await readFile(hooksFile, 'utf-8')).toBe(first);
  });

  it('leaves the file alone, without throwing, when no .cmd sits beside the shim', async () => {
    const before = await readFile(hooksFile, 'utf-8');
    await expect(localize('win32')).resolves.toBeUndefined();
    expect(await readFile(hooksFile, 'utf-8')).toBe(before);
  });

  it('leaves the file alone on non-win32', async () => {
    await writeFile(`${shim}.cmd`, '@echo off');
    const before = await readFile(hooksFile, 'utf-8');
    await localize('linux');
    expect(await readFile(hooksFile, 'utf-8')).toBe(before);
  });
});
