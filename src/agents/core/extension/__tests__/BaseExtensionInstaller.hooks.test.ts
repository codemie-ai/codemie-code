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
