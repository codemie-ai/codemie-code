/**
 * Verifies ClaudePluginInstaller keeps the installed hooks.json in exec form on
 * Windows on every install call, and leaves it alone on other platforms.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentMetadata } from '../../../core/types.js';

const metadata: AgentMetadata = {
  name: 'claude',
  displayName: 'Claude Code',
  description: 'Test',
  npmPackage: '@anthropic-ai/claude-code',
  cliCommand: 'claude',
  envMapping: {},
  supportedProviders: ['ai-run-sso'],
  dataPaths: { home: '.claude' },
};

const bundledHooks = {
  description: 'CodeMie session tracking hooks',
  hooks: {
    SessionStart: [
      {
        hooks: [
          { type: 'command', command: 'codemie hook', timeout: 60 },
          { type: 'command', command: 'codemie sound SessionStart' },
          { type: 'command', command: 'echo hi' },
        ],
      },
    ],
  },
};

const toForwardSlash = (p: string): string => p.replaceAll('\\', '/');

describe('ClaudePluginInstaller hooks refresh', () => {
  let src = '';
  let home = '';
  let nodePath = '';
  let scriptPath = '';
  let installedHooksFile = '';
  const warn = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    warn.mockReset();
    vi.doMock('../../../../utils/processes.js', () => ({
      getCommandPath: vi.fn().mockResolvedValue('/abs/codemie'),
    }));
    vi.doMock('../../../../utils/logger.js', () => ({
      logger: { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() },
    }));

    src = await mkdtemp(join(tmpdir(), 'claude-plugin-src-'));
    home = await mkdtemp(join(tmpdir(), 'claude-plugin-home-'));
    nodePath = join(home, 'Program Files', 'nodejs', 'node.exe');
    scriptPath = join(home, 'bin', 'codemie.js');
    installedHooksFile = join(home, 'claude-plugin', 'hooks', 'hooks.json');

    await mkdir(join(home, 'bin'), { recursive: true });
    await writeFile(scriptPath, '');
    await mkdir(join(src, 'hooks'), { recursive: true });
    await mkdir(join(src, '.claude-plugin'), { recursive: true });
    await writeFile(join(src, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.0' }));
    await writeFile(join(src, 'README.md'), '# x');
    await writeFile(join(src, 'hooks', 'hooks.json'), JSON.stringify(bundledHooks, null, 2));

    vi.spyOn(process, 'execPath', 'get').mockReturnValue(nodePath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(src, { recursive: true, force: true, maxRetries: 3 });
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  function setPlatform(platform: NodeJS.Platform): void {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  }

  async function createInstaller(codemieScript: string = scriptPath) {
    const { ClaudePluginInstaller } = await import('../claude.plugin-installer.js');
    class TestInstaller extends ClaudePluginInstaller {
      protected getSourcePath(): string {
        return src;
      }
      getTargetPath(): string {
        return join(home, 'claude-plugin');
      }
      protected getCodemieScriptPath(): string {
        return codemieScript;
      }
    }
    return new TestInstaller(metadata);
  }

  async function expectedHooks(): Promise<unknown> {
    const { toExecFormHooks } = await import('../../../../utils/hook-command.js');
    return toExecFormHooks(bundledHooks, nodePath, scriptPath);
  }

  async function readInstalledRaw(): Promise<string> {
    return readFile(installedHooksFile, 'utf-8');
  }

  it('win32: writes exec form on a fresh install and again on a version update', async () => {
    setPlatform('win32');
    const installer = await createInstaller();
    const expected = await expectedHooks();

    const first = await installer.install();
    expect(first).toMatchObject({ success: true, action: 'copied' });
    const installed = JSON.parse(await readInstalledRaw());
    expect(installed).toEqual(expected);
    expect(installed.hooks.SessionStart[0].hooks).toEqual([
      {
        type: 'command',
        command: toForwardSlash(nodePath),
        args: [toForwardSlash(scriptPath), 'hook'],
        timeout: 60,
      },
      {
        type: 'command',
        command: toForwardSlash(nodePath),
        args: [toForwardSlash(scriptPath), 'sound', 'SessionStart'],
      },
      { type: 'command', command: 'echo hi' },
    ]);

    await writeFile(join(src, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.1' }));
    const second = await installer.install();
    expect(second).toMatchObject({ success: true, action: 'updated' });
    expect(JSON.parse(await readInstalledRaw())).toEqual(expected);
  });

  it('win32: rewrites a shell-form file left by an earlier install without a version change', async () => {
    setPlatform('linux');
    const installer = await createInstaller();
    await installer.install();
    expect(JSON.parse(await readInstalledRaw()).hooks.SessionStart[0].hooks[0].command).toBe('/abs/codemie hook');

    setPlatform('win32');
    const result = await installer.install();

    expect(result).toMatchObject({ success: true, action: 'already_exists' });
    expect(JSON.parse(await readInstalledRaw())).toEqual(await expectedHooks());
  });

  it('win32: rewrites an exec-form file that points at another node binary', async () => {
    setPlatform('win32');
    const installer = await createInstaller();
    await installer.install();
    const { toExecFormHooks } = await import('../../../../utils/hook-command.js');
    const stale = toExecFormHooks(bundledHooks, join(home, 'old', 'node.exe'), scriptPath);
    await writeFile(installedHooksFile, JSON.stringify(stale, null, 2));

    const result = await installer.install();

    expect(result).toMatchObject({ success: true, action: 'already_exists' });
    expect(JSON.parse(await readInstalledRaw())).toEqual(await expectedHooks());
  });

  it('win32: does not write when the installed file parses to the expected value', async () => {
    setPlatform('win32');
    const installer = await createInstaller();
    await installer.install();
    const compact = JSON.stringify(await expectedHooks());
    await writeFile(installedHooksFile, compact);

    const result = await installer.install();

    expect(result).toMatchObject({ success: true, action: 'already_exists' });
    expect(await readInstalledRaw()).toBe(compact);
  });

  it('win32: rewrites an installed file that is not valid JSON', async () => {
    setPlatform('win32');
    const installer = await createInstaller();
    await installer.install();
    await writeFile(installedHooksFile, 'not json');

    const result = await installer.install();

    expect(result).toMatchObject({ success: true, action: 'already_exists' });
    expect(JSON.parse(await readInstalledRaw())).toEqual(await expectedHooks());
  });

  it('win32: warns and leaves the file and the result unchanged when the CLI script is missing', async () => {
    setPlatform('linux');
    const installer = await createInstaller(join(home, 'bin', 'missing.js'));
    await installer.install();
    const before = await readInstalledRaw();
    warn.mockClear();

    setPlatform('win32');
    const result = await installer.install();

    expect(result).toMatchObject({ success: true, action: 'already_exists' });
    expect(await readInstalledRaw()).toBe(before);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('[claude]');
  });

  it('linux: a second install leaves the shell-form file untouched', async () => {
    setPlatform('linux');
    const installer = await createInstaller();
    await installer.install();
    const before = await readInstalledRaw();

    const result = await installer.install();

    expect(result).toMatchObject({ success: true, action: 'already_exists' });
    expect(await readInstalledRaw()).toBe(before);
    expect(JSON.parse(before).hooks.SessionStart[0].hooks[0]).toEqual({
      type: 'command',
      command: '/abs/codemie hook',
      timeout: 60,
    });
  });
});
