import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CodexAcpPlugin, CodexAcpPluginMetadata, syncModelCatalogToConfigToml } from '../codex-acp.plugin.js';
import { CodexPluginMetadata } from '../codex.plugin.js';

const ORIGINAL_CODEMIE_HOME = process.env.CODEMIE_HOME;

beforeEach(async () => {
  // beforeRun writes/creates CODEX_HOME via resolveHomeDir, which respects
  // CODEMIE_HOME — isolate it from the real home directory.
  process.env.CODEMIE_HOME = await mkdtemp(join(tmpdir(), 'codemie-codex-acp-'));
});

afterEach(() => {
  if (ORIGINAL_CODEMIE_HOME === undefined) {
    delete process.env.CODEMIE_HOME;
  } else {
    process.env.CODEMIE_HOME = ORIGINAL_CODEMIE_HOME;
  }
});

describe('CodexAcpPluginMetadata', () => {
  it('has ACP-specific identity and no version gate', () => {
    expect(CodexAcpPluginMetadata.name).toBe('codex-acp');
    expect(CodexAcpPluginMetadata.cliCommand).toBe('codex-acp');
    expect(CodexAcpPluginMetadata.npmPackage).toBe('@agentclientprotocol/codex-acp');
    expect(CodexAcpPluginMetadata.supportedVersion).toBeUndefined();
    expect(CodexAcpPluginMetadata.minimumSupportedVersion).toBeUndefined();
  });

  it('uses the ACP-specific SSO client type', () => {
    expect(CodexAcpPluginMetadata.ssoConfig).toEqual({
      enabled: true,
      clientType: 'codemie-codex-acp',
    });
  });

  it('has no flag mappings and is silent', () => {
    expect(CodexAcpPluginMetadata.flagMappings).toEqual({});
    expect(CodexAcpPluginMetadata.silentMode).toBe(true);
  });

  it('inherits onSessionStart/onSessionEnd from CodexPluginMetadata', () => {
    expect(CodexAcpPluginMetadata.lifecycle?.onSessionStart).toBe(CodexPluginMetadata.lifecycle?.onSessionStart);
    expect(CodexAcpPluginMetadata.lifecycle?.onSessionEnd).toBe(CodexPluginMetadata.lifecycle?.onSessionEnd);
  });

  describe('enrichArgs', () => {
    it('is an identity pass-through — codex-acp ignores stray argv', () => {
      const result = CodexAcpPluginMetadata.lifecycle!.enrichArgs!(['foo', 'bar'], {} as never);
      expect(result).toEqual(['foo', 'bar']);
    });
  });

  describe('beforeRun', () => {
    // beforeRun now syncs CODEX_HOME/config.toml; without an explicit CODEX_HOME it would
    // resolve under the real home (resolveHomeDir ignores CODEMIE_HOME) and rewrite the
    // developer's actual ~/.codex/codemie/home/config.toml.
    const callBeforeRun = async (env: NodeJS.ProcessEnv) =>
      (CodexAcpPluginMetadata.lifecycle!.beforeRun as (env: NodeJS.ProcessEnv, config: never) => Promise<NodeJS.ProcessEnv>)(
        { CODEX_HOME: await mkdtemp(join(tmpdir(), 'codemie-codex-acp-home-')), ...env },
        {} as never,
      );

    it('injects CODEX_CONFIG with the codemie provider when an API key and base URL are present', async () => {
      const result = await callBeforeRun({
        CODEMIE_API_KEY: 'sk-test',
        CODEMIE_BASE_URL: 'https://proxy.example.com',
        CODEMIE_MODEL: 'gpt-5.5',
      });

      expect(result.CODEX_HOME).toBeDefined();
      const config = JSON.parse(result.CODEX_CONFIG!);
      expect(config.model_provider).toBe('codemie');
      expect(config.model_providers.codemie).toEqual({
        name: 'codemie',
        base_url: 'https://proxy.example.com',
        env_key: 'CODEMIE_API_KEY',
        wire_api: 'responses',
      });
      expect(config.model).toBe('gpt-5.5');
      expect(config.max_output_tokens).toBe(16384);
    });

    it('leaves CODEX_CONFIG untouched when the API key is the ollama placeholder and provider is not ollama', async () => {
      const result = await callBeforeRun({
        CODEMIE_API_KEY: 'not-required',
        CODEMIE_BASE_URL: 'https://proxy.example.com',
      });

      expect(result.CODEX_CONFIG).toBeUndefined();
    });

    it('injects the provider for ollama even with the not-required placeholder key', async () => {
      const result = await callBeforeRun({
        CODEMIE_API_KEY: 'not-required',
        CODEMIE_PROVIDER: 'ollama',
        CODEMIE_BASE_URL: 'http://localhost:11434',
      });

      expect(result.CODEX_CONFIG).toBeDefined();
      const config = JSON.parse(result.CODEX_CONFIG!);
      expect(config.model_provider).toBe('codemie');
    });

    it('sets max_output_tokens to 128000 for GPT-6/5.6-family models', async () => {
      const result = await callBeforeRun({
        CODEMIE_API_KEY: 'sk-test',
        CODEMIE_BASE_URL: 'https://proxy.example.com',
        CODEMIE_MODEL: 'gpt-6.1-sol',
      });

      const config = JSON.parse(result.CODEX_CONFIG!);
      expect(config.max_output_tokens).toBe(128000);
    });

    it('merges with a pre-existing CODEX_CONFIG rather than overwriting it', async () => {
      const result = await callBeforeRun({
        CODEMIE_API_KEY: 'sk-test',
        CODEMIE_BASE_URL: 'https://proxy.example.com',
        CODEX_CONFIG: JSON.stringify({ custom_user_key: 'keep-me', model_provider: 'should-be-overwritten' }),
      });

      const config = JSON.parse(result.CODEX_CONFIG!);
      expect(config.custom_user_key).toBe('keep-me');
      expect(config.model_provider).toBe('codemie');
    });

    it('falls back to our own config when a pre-existing CODEX_CONFIG is malformed JSON', async () => {
      const result = await callBeforeRun({
        CODEMIE_API_KEY: 'sk-test',
        CODEMIE_BASE_URL: 'https://proxy.example.com',
        CODEX_CONFIG: '{not valid json',
      });

      const config = JSON.parse(result.CODEX_CONFIG!);
      expect(config.model_provider).toBe('codemie');
    });

    it('sets CODEX_HOME even when no provider config is injected', async () => {
      const result = await callBeforeRun({});

      expect(result.CODEX_HOME).toBeDefined();
      expect(result.CODEX_CONFIG).toBeUndefined();
    });
  });
});

describe('CodexAcpPlugin', () => {
  it('uses ACP metadata', () => {
    const plugin = new CodexAcpPlugin();
    expect(plugin.name).toBe('codex-acp');
  });

  it('getVersion resolves null — the ACP wrapper version is not gated', async () => {
    const plugin = new CodexAcpPlugin();
    await expect(plugin.getVersion()).resolves.toBeNull();
  });

  it('install/isInstalled delegate to BaseAgentAdapter.prototype', async () => {
    const { BaseAgentAdapter } = await import('../../../core/BaseAgentAdapter.js');
    const installSpy = vi.spyOn(BaseAgentAdapter.prototype, 'install').mockResolvedValue(undefined);
    const isInstalledSpy = vi.spyOn(BaseAgentAdapter.prototype, 'isInstalled').mockResolvedValue(true);

    const plugin = new CodexAcpPlugin();
    await plugin.install();
    await expect(plugin.isInstalled()).resolves.toBe(true);

    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(isInstalledSpy).toHaveBeenCalledTimes(1);

    installSpy.mockRestore();
    isInstalledSpy.mockRestore();
  });
});

describe('syncModelCatalogToConfigToml', () => {
  const setup = async (initial?: string) => {
    const home = await mkdtemp(join(tmpdir(), 'codemie-codex-toml-'));
    if (initial !== undefined) await writeFile(join(home, 'config.toml'), initial);
    return { home, read: () => readFile(join(home, 'config.toml'), 'utf-8') };
  };

  it('creates config.toml with a top-level model_catalog_json', async () => {
    const { home, read } = await setup();
    await syncModelCatalogToConfigToml(home, '/x/models.json');
    expect(await read()).toBe('model_catalog_json = "/x/models.json"\n');
  });

  it('puts the key above existing tables and keeps them untouched', async () => {
    const table = '[projects."/work"]\ntrust_level = "trusted"\n';
    const { home, read } = await setup(table);
    await syncModelCatalogToConfigToml(home, '/x/models.json');
    expect(await read()).toBe(`model_catalog_json = "/x/models.json"\n${table}`);
  });

  it('replaces a stale pointer instead of duplicating it', async () => {
    const { home, read } = await setup('model_catalog_json = "/old.json"\n[a]\nb = 1\n');
    await syncModelCatalogToConfigToml(home, '/new.json');
    expect(await read()).toBe('model_catalog_json = "/new.json"\n[a]\nb = 1\n');
  });

  it('does not touch a same-named key inside a table', async () => {
    const table = '[a]\nmodel_catalog_json = "keep"\n';
    const { home, read } = await setup(table);
    await syncModelCatalogToConfigToml(home, '/x.json');
    expect(await read()).toBe(`model_catalog_json = "/x.json"\n${table}`);
  });

  it('removes the pointer when no catalog is configured', async () => {
    const { home, read } = await setup('model_catalog_json = "/old.json"\n[a]\nb = 1\n');
    await syncModelCatalogToConfigToml(home, undefined);
    expect(await read()).toBe('[a]\nb = 1\n');
  });

  it('is a no-op (no file created) when there is nothing to write', async () => {
    const { home } = await setup();
    await syncModelCatalogToConfigToml(home, undefined);
    await expect(readFile(join(home, 'config.toml'), 'utf-8')).rejects.toThrow();
  });

  it('is wired into beforeRun via CODEMIE_CODEX_MODEL_CATALOG_JSON', async () => {
    // Explicit CODEX_HOME: beforeRun's default resolves under the real home, not CODEMIE_HOME.
    const { home } = await setup();
    const result = await (CodexAcpPluginMetadata.lifecycle!.beforeRun as (env: NodeJS.ProcessEnv, config: never) => Promise<NodeJS.ProcessEnv>)(
      { CODEX_HOME: home, CODEMIE_CODEX_MODEL_CATALOG_JSON: '/cat/models.json' },
      {} as never,
    );
    const toml = await readFile(join(result.CODEX_HOME!, 'config.toml'), 'utf-8');
    expect(toml).toContain('model_catalog_json = "/cat/models.json"');
  });
});
