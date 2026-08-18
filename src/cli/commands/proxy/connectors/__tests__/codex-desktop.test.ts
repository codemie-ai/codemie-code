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

describe('discoverCodexModels', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('requests the gateway model list with the bearer key and keeps Codex-compatible ids', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [
        { deployment_name: 'gpt-5-codex', enabled: true },
        { deployment_name: 'claude-sonnet-4-6', enabled: true },
        { deployment_name: 'text-embedding-3-large', enabled: true },
      ],
    } as unknown as Response);

    const { discoverCodexModels } = await import('../codex-desktop.js');
    const models = await discoverCodexModels('http://127.0.0.1:4001', 'codemie-proxy');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/v1/llm_models?include_all=true');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer codemie-proxy' });
    expect(models).toContain('gpt-5-codex');
    expect(models).not.toContain('claude-sonnet-4-6');
    expect(models).not.toContain('text-embedding-3-large');
  });

  it('throws ConfigurationError when the proxy exposes no compatible model', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{ deployment_name: 'claude-sonnet-4-6', enabled: true }],
    } as unknown as Response);

    const { discoverCodexModels } = await import('../codex-desktop.js');
    const { ConfigurationError } = await import('@/utils/errors.js');

    await expect(discoverCodexModels('http://127.0.0.1:4001', 'k')).rejects.toThrow(ConfigurationError);
  });

  it('throws ConfigurationError when the proxy returns a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 502 } as unknown as Response);

    const { discoverCodexModels } = await import('../codex-desktop.js');
    const { ConfigurationError } = await import('@/utils/errors.js');

    await expect(discoverCodexModels('http://127.0.0.1:4001', 'k')).rejects.toThrow(ConfigurationError);
  });

  it('rejects an explicitly requested model that the proxy does not expose', async () => {
    const { selectCodexModel } = await import('../codex-desktop.js');
    const { ConfigurationError } = await import('@/utils/errors.js');

    expect(() => selectCodexModel(['gpt-5-codex'], 'gpt-4o')).toThrow(ConfigurationError);
    expect(selectCodexModel(['gpt-5-codex', 'gpt-5'], undefined)).toBe('gpt-5-codex');
    expect(selectCodexModel(['gpt-5-codex', 'gpt-5'], 'gpt-5')).toBe('gpt-5');
  });
});
