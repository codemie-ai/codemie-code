/**
 * Codex desktop connector — path resolution, app detection and config writing.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { TempWorkspace } from '../../../../../../tests/helpers/temp-workspace.js';

describe('getCodexDesktopConfigPath', () => {
  const originalCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    vi.resetModules();
  });

  it('honours a user-set CODEX_HOME', async () => {
    process.env.CODEX_HOME = '/tmp/custom-codex';
    const { getCodexDesktopConfigPath } = await import('../codex-desktop.js');
    expect(getCodexDesktopConfigPath()).toBe(join('/tmp/custom-codex', 'config.toml'));
  });

  it('falls back to <home>/.codex/config.toml', async () => {
    delete process.env.CODEX_HOME;
    const { homedir } = await import('os');
    const { getCodexDesktopConfigPath } = await import('../codex-desktop.js');
    expect(getCodexDesktopConfigPath()).toBe(join(homedir(), '.codex', 'config.toml'));
  });
});

describe('findCodexDesktopApp', () => {
  let workspace: TempWorkspace;

  beforeEach(() => { workspace = new TempWorkspace('codemie-codex-app-'); });
  afterEach(() => { workspace.cleanup(); vi.resetModules(); });

  it('returns null when no candidate path exists', async () => {
    const { findCodexDesktopApp } = await import('../codex-desktop.js');
    expect(findCodexDesktopApp([join(workspace.path, 'missing.app')])).toBeNull();
  });

  it('returns the first candidate that exists', async () => {
    workspace.writeFile('ChatGPT.app/Contents/Info.plist', '<plist/>');
    const appDir = join(workspace.path, 'ChatGPT.app');
    const { findCodexDesktopApp } = await import('../codex-desktop.js');
    expect(findCodexDesktopApp([join(workspace.path, 'missing.app'), appDir])).toBe(appDir);
  });
});

describe('backupIfUnmanaged', () => {
  let workspace: TempWorkspace;

  beforeEach(() => { workspace = new TempWorkspace('codemie-codex-backup-'); });
  afterEach(() => { workspace.cleanup(); vi.resetModules(); });

  it('backs up a config that carries no managed region', async () => {
    const configPath = workspace.writeFile('config.toml', 'model = "gpt-5"\n');
    const { backupIfUnmanaged } = await import('../codex-desktop.js');

    const backupPath = await backupIfUnmanaged(configPath, 'model = "gpt-5"\n');

    expect(backupPath).toBe(`${configPath}.codemie-backup`);
    expect(workspace.readFile('config.toml.codemie-backup')).toBe('model = "gpt-5"\n');
  });

  it('does not overwrite the backup when the config is already managed', async () => {
    const { HEADER_OPEN, HEADER_CLOSE } = await import('../codex-config-toml.js');
    const managed = `${HEADER_OPEN}\nmodel_provider = "codemie"\n${HEADER_CLOSE}\n`;
    const configPath = workspace.writeFile('config.toml', managed);
    workspace.writeFile('config.toml.codemie-backup', 'ORIGINAL\n');
    const { backupIfUnmanaged } = await import('../codex-desktop.js');

    await backupIfUnmanaged(configPath, managed);

    expect(workspace.readFile('config.toml.codemie-backup')).toBe('ORIGINAL\n');
  });

  it('returns null when there is no config file to back up', async () => {
    const { backupIfUnmanaged } = await import('../codex-desktop.js');
    expect(await backupIfUnmanaged(join(workspace.path, 'absent.toml'), '')).toBeNull();
  });
});
