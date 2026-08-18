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

describe('writeCodexDesktopConfig', () => {
  let workspace: TempWorkspace;

  beforeEach(() => { workspace = new TempWorkspace('codemie-codex-write-'); });
  afterEach(() => { workspace.cleanup(); vi.restoreAllMocks(); vi.resetModules(); });

  const opts = (configPath: string, statePath: string, extra: Record<string, unknown> = {}) => ({
    configPath,
    statePath,
    proxyUrl: 'http://127.0.0.1:4001',
    baseUrl: 'http://127.0.0.1:4001/v1',
    gatewayKey: 'codemie-proxy',
    model: 'gpt-5-codex',
    ...extra,
  });

  it('splices the managed block and preserves unrelated keys and comments', async () => {
    const configPath = workspace.writeFile(
      'config.toml',
      '# keep me\nsandbox_mode = "workspace-write"\n\n[history]\npersistence = "none"\n'
    );
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig } = await import('../codex-desktop.js');

    await writeCodexDesktopConfig(opts(configPath, statePath));

    const written = workspace.readFile('config.toml');
    expect(written).toContain('# keep me');
    expect(written).toContain('persistence = "none"');
    expect(written).toContain('model_providers.codemie');
    expect(written).toContain('wire_api = "responses"');
  });

  it('writes marker state before the config so ownership is never lost', async () => {
    const configPath = workspace.writeFile('config.toml', 'model = "gpt-5"\n');
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig } = await import('../codex-desktop.js');

    await writeCodexDesktopConfig(opts(configPath, statePath));

    const state = JSON.parse(workspace.readFile('state.json'));
    expect(state).toMatchObject({ configPath, model: 'gpt-5-codex' });
    expect(state.backupPath).toBe(`${configPath}.codemie-backup`);
  });

  it('creates the config when none exists', async () => {
    const configPath = join(workspace.path, 'fresh', 'config.toml');
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig } = await import('../codex-desktop.js');

    await writeCodexDesktopConfig(opts(configPath, statePath));

    expect(workspace.readFile('fresh/config.toml')).toContain('model_provider = "codemie"');
  });

  it('rejects malformed TOML and leaves the file untouched', async () => {
    const malformed = 'this is [not = toml\n';
    const configPath = workspace.writeFile('config.toml', malformed);
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig } = await import('../codex-desktop.js');
    const { ConfigurationError } = await import('@/utils/errors.js');

    await expect(writeCodexDesktopConfig(opts(configPath, statePath))).rejects.toThrow(ConfigurationError);
    expect(workspace.readFile('config.toml')).toBe(malformed);
  });

  it('refuses a foreign model_provider unless forced', async () => {
    const existing = 'model_provider = "someone-else"\n\n[model_providers.someone-else]\nbase_url = "http://x/v1"\n';
    const configPath = workspace.writeFile('config.toml', existing);
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig } = await import('../codex-desktop.js');

    await expect(writeCodexDesktopConfig(opts(configPath, statePath))).rejects.toThrow(/someone-else/);
    expect(workspace.readFile('config.toml')).toBe(existing);

    await expect(
      writeCodexDesktopConfig(opts(configPath, statePath, { force: true }))
    ).resolves.toBeDefined();
  });

  it('is idempotent - a second write does not duplicate the managed block', async () => {
    const configPath = workspace.writeFile('config.toml', 'sandbox_mode = "workspace-write"\n');
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig } = await import('../codex-desktop.js');

    await writeCodexDesktopConfig(opts(configPath, statePath));
    const first = workspace.readFile('config.toml');
    await writeCodexDesktopConfig(opts(configPath, statePath));

    expect(workspace.readFile('config.toml')).toBe(first);
  });
});

describe('removeCodexDesktopConfig', () => {
  let workspace: TempWorkspace;

  beforeEach(() => { workspace = new TempWorkspace('codemie-codex-remove-'); });
  afterEach(() => { workspace.cleanup(); vi.restoreAllMocks(); vi.resetModules(); });

  it('restores the pre-connect content by stripping the managed regions', async () => {
    const original = '# notes\nmodel = "gpt-5"\n\n[history]\npersistence = "none"\n';
    const configPath = workspace.writeFile('config.toml', original);
    const statePath = join(workspace.path, 'state.json');
    const { writeCodexDesktopConfig, removeCodexDesktopConfig } = await import('../codex-desktop.js');

    await writeCodexDesktopConfig({
      configPath,
      statePath,
      proxyUrl: 'http://127.0.0.1:4001',
      baseUrl: 'http://127.0.0.1:4001/v1',
      gatewayKey: 'k',
      model: 'gpt-5-codex',
    });
    const result = await removeCodexDesktopConfig(statePath);

    expect(result.removed).toBe(true);
    expect(result.usedBackup).toBe(false);
    expect(workspace.readFile('config.toml')).toBe(original);
  });

  it('reports a clean no-op when no marker state exists', async () => {
    const { removeCodexDesktopConfig } = await import('../codex-desktop.js');
    const result = await removeCodexDesktopConfig(join(workspace.path, 'absent.json'));
    expect(result).toMatchObject({ removed: false, usedBackup: false });
  });

  it('falls back to the backup when the stripped result will not parse', async () => {
    const { HEADER_OPEN, HEADER_CLOSE } = await import('../codex-config-toml.js');
    // Valid managed region wrapping content that is not valid TOML on its own.
    const configPath = workspace.writeFile(
      'config.toml',
      `${HEADER_OPEN}\nmodel_provider = "codemie"\n${HEADER_CLOSE}\n\nthis is [not = toml\n`
    );
    workspace.writeFile('config.toml.codemie-backup', 'model = "gpt-5"\n');
    const statePath = workspace.writeFile('state.json', JSON.stringify({
      configPath,
      backupPath: `${configPath}.codemie-backup`,
      model: 'gpt-5-codex',
      writtenAt: '2026-08-18T00:00:00Z',
    }));

    const { removeCodexDesktopConfig } = await import('../codex-desktop.js');
    const result = await removeCodexDesktopConfig(statePath);

    expect(result.usedBackup).toBe(true);
    expect(workspace.readFile('config.toml')).toBe('model = "gpt-5"\n');
  });

  it('throws when the stripped result will not parse and no backup exists', async () => {
    const { HEADER_OPEN, HEADER_CLOSE } = await import('../codex-config-toml.js');
    const configPath = workspace.writeFile(
      'config.toml',
      `${HEADER_OPEN}\nmodel_provider = "codemie"\n${HEADER_CLOSE}\n\nthis is [not = toml\n`
    );
    const statePath = workspace.writeFile('state.json', JSON.stringify({
      configPath,
      backupPath: null,
      model: 'gpt-5-codex',
      writtenAt: '2026-08-18T00:00:00Z',
    }));

    const { removeCodexDesktopConfig } = await import('../codex-desktop.js');
    const { ConfigurationError } = await import('@/utils/errors.js');

    await expect(removeCodexDesktopConfig(statePath)).rejects.toThrow(ConfigurationError);
  });
});
