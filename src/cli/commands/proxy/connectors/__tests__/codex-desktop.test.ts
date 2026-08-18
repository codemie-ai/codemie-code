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
