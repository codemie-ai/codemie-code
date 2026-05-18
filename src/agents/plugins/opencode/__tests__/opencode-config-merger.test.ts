/**
 * Unit tests for opencode-config-merger
 *
 * Covers:
 * - readUserOpenCodeConfig: file reading / parsing / error handling
 * - mergeProviderMaps: CodeMie-owned vs user-owned provider keys
 * - mergeEnabledProviders: union + dedup + order preservation
 * - mergePluginArrays: union + dedup
 * - mergeOpenCodeProviders: end-to-end merge rules
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Logger mock (shared)
vi.mock('../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setAgentName: vi.fn(),
    setSessionId: vi.fn(),
    setProfileName: vi.fn(),
  },
}));

// We import dynamically to let the mocks apply.
const {
  readUserOpenCodeConfig,
  mergeProviderMaps,
  mergeEnabledProviders,
  mergePluginArrays,
  mergeOpenCodeProviders,
  CODEMIE_OWNED_PROVIDER_KEYS,
} = await import('../opencode-config-merger.js');

/* ------------------------------------------------------------------ */
/* readUserOpenCodeConfig                                             */
/* ------------------------------------------------------------------ */

describe('readUserOpenCodeConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codemie-merge-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when file does not exist', async () => {
    const path = join(tmpDir, 'no-such-file.json');
    const result = await readUserOpenCodeConfig(path);
    expect(result).toBeNull();
  });

  it('returns parsed object when file is valid JSON', async () => {
    const path = join(tmpDir, 'config.json');
    writeFileSync(path, JSON.stringify({ model: 'anthropic/claude-sonnet-4-5' }));
    const result = await readUserOpenCodeConfig(path);
    expect(result).toEqual({ model: 'anthropic/claude-sonnet-4-5' });
  });

  it('returns null on malformed JSON and does not throw', async () => {
    const path = join(tmpDir, 'config.json');
    writeFileSync(path, '{ not valid json ');
    const result = await readUserOpenCodeConfig(path);
    expect(result).toBeNull();
  });

  it('returns null when JSON root is a primitive', async () => {
    const path = join(tmpDir, 'config.json');
    writeFileSync(path, '"just a string"');
    const result = await readUserOpenCodeConfig(path);
    expect(result).toBeNull();
  });

  it('returns null when JSON root is an array', async () => {
    const path = join(tmpDir, 'config.json');
    writeFileSync(path, '[1, 2, 3]');
    const result = await readUserOpenCodeConfig(path);
    expect(result).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* mergeProviderMaps                                                  */
/* ------------------------------------------------------------------ */

describe('mergeProviderMaps', () => {
  it('passes through user-only providers unchanged', () => {
    const codeMie = {};
    const user = {
      anthropic: { options: { apiKey: 'user-key' } },
      'github-copilot': { name: 'Copilot' },
    };
    const result = mergeProviderMaps(codeMie, user);
    expect(result.anthropic).toEqual({ options: { apiKey: 'user-key' } });
    expect(result['github-copilot']).toEqual({ name: 'Copilot' });
  });

  it('CodeMie-owned keys win when present in CodeMie config', () => {
    const codeMie = {
      'codemie-proxy': { name: 'CodeMie SSO', models: { 'fresh-model': {} } },
    };
    const user = {
      'codemie-proxy': { name: 'Stale', models: { 'stale-model': {} } },
      anthropic: { name: 'Anthropic' },
    };
    const result = mergeProviderMaps(codeMie, user);
    expect(result['codemie-proxy']).toEqual({
      name: 'CodeMie SSO',
      models: { 'fresh-model': {} },
    });
    expect(result.anthropic).toEqual({ name: 'Anthropic' });
  });

  it('preserves user entry for owned key when CodeMie did not emit it', () => {
    // E.g. no Responses-API models → CodeMie does not emit `openai` entry;
    // user's existing openai provider should survive.
    const codeMie = {
      'codemie-proxy': { name: 'CodeMie SSO' },
    };
    const user = {
      openai: { options: { apiKey: 'user-openai-key' } },
    };
    const result = mergeProviderMaps(codeMie, user);
    expect(result.openai).toEqual({ options: { apiKey: 'user-openai-key' } });
    expect(result['codemie-proxy']).toEqual({ name: 'CodeMie SSO' });
  });

  it('returns only CodeMie providers when user map is empty', () => {
    const codeMie = { 'codemie-proxy': { name: 'X' }, ollama: { name: 'O' } };
    const result = mergeProviderMaps(codeMie, {});
    expect(result).toEqual(codeMie);
  });

  it('exposes CODEMIE_OWNED_PROVIDER_KEYS containing expected keys', () => {
    expect(CODEMIE_OWNED_PROVIDER_KEYS).toEqual(
      expect.arrayContaining(['codemie-proxy', 'openai', 'ollama', 'amazon-bedrock']),
    );
  });
});

/* ------------------------------------------------------------------ */
/* mergeEnabledProviders                                              */
/* ------------------------------------------------------------------ */

describe('mergeEnabledProviders', () => {
  it('returns union without duplicates, CodeMie order first', () => {
    const result = mergeEnabledProviders(
      ['codemie-proxy', 'openai', 'ollama', 'amazon-bedrock'],
      ['anthropic', 'codemie-proxy', 'github-copilot'],
    );
    expect(result).toEqual([
      'codemie-proxy',
      'openai',
      'ollama',
      'amazon-bedrock',
      'anthropic',
      'github-copilot',
    ]);
  });

  it('handles missing user list', () => {
    const result = mergeEnabledProviders(['codemie-proxy'], undefined);
    expect(result).toEqual(['codemie-proxy']);
  });

  it('handles missing CodeMie list', () => {
    const result = mergeEnabledProviders(undefined, ['anthropic']);
    expect(result).toEqual(['anthropic']);
  });

  it('ignores non-string entries', () => {
    const result = mergeEnabledProviders(
      ['codemie-proxy', 42, null],
      ['anthropic', { bad: 'shape' }],
    );
    expect(result).toEqual(['codemie-proxy', 'anthropic']);
  });

  it('returns empty array when both inputs missing / invalid', () => {
    expect(mergeEnabledProviders(null, null)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* mergePluginArrays                                                  */
/* ------------------------------------------------------------------ */

describe('mergePluginArrays', () => {
  it('returns union without duplicates', () => {
    const result = mergePluginArrays(
      ['file:///codemie/hooks.js'],
      ['file:///user/plugin.js', 'file:///codemie/hooks.js'],
    );
    expect(result).toEqual(['file:///codemie/hooks.js', 'file:///user/plugin.js']);
  });

  it('returns undefined when both inputs are absent', () => {
    expect(mergePluginArrays(undefined, undefined)).toBeUndefined();
  });

  it('handles only user plugins', () => {
    const result = mergePluginArrays(undefined, ['file:///u.js']);
    expect(result).toEqual(['file:///u.js']);
  });

  it('handles only CodeMie plugins', () => {
    const result = mergePluginArrays(['file:///c.js'], undefined);
    expect(result).toEqual(['file:///c.js']);
  });
});

/* ------------------------------------------------------------------ */
/* mergeOpenCodeProviders (end-to-end)                                */
/* ------------------------------------------------------------------ */

describe('mergeOpenCodeProviders', () => {
  let tmpDir: string;
  let userConfigPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codemie-merge-test-'));
    userConfigPath = join(tmpDir, 'config.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildCodeMieConfig(): Record<string, unknown> {
    // Mirrors the shape produced in opencode.plugin.ts beforeRun()
    return {
      enabled_providers: ['codemie-proxy', 'openai', 'ollama', 'amazon-bedrock'],
      share: 'disabled',
      provider: {
        'codemie-proxy': {
          npm: '@ai-sdk/openai-compatible',
          name: 'CodeMie SSO',
          options: { baseURL: 'http://localhost:9999/', apiKey: 'proxy-handled' },
          models: { 'gpt-5-2-2025-12-11': { id: 'gpt-5-2-2025-12-11' } },
        },
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Ollama',
          options: { baseURL: 'http://localhost:11434/v1/', apiKey: 'ollama' },
        },
      },
      model: 'codemie-proxy/gpt-5-2-2025-12-11',
    };
  }

  it('no-op when user config is missing', async () => {
    const cfg = buildCodeMieConfig();
    const snapshot = JSON.stringify(cfg);
    // point to a non-existent file
    await mergeOpenCodeProviders(cfg, join(tmpDir, 'missing.json'));
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });

  it('no-op on corrupt user config, does not throw', async () => {
    writeFileSync(userConfigPath, '{ not: valid json');
    const cfg = buildCodeMieConfig();
    const snapshot = JSON.stringify(cfg);
    await expect(mergeOpenCodeProviders(cfg, userConfigPath)).resolves.toBeUndefined();
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });

  it('passes through user extras (anthropic, github-copilot) while keeping codemie-proxy fresh', async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      provider: {
        anthropic: { options: { apiKey: 'user-anthropic' } },
        'github-copilot': { name: 'Copilot' },
        // stale codemie-proxy must be replaced
        'codemie-proxy': { options: { baseURL: 'http://stale:1/' }, models: { stale: {} } },
      },
      enabled_providers: ['anthropic', 'github-copilot'],
    }));

    const cfg = buildCodeMieConfig();
    await mergeOpenCodeProviders(cfg, userConfigPath);

    const providers = cfg.provider as Record<string, unknown>;
    expect(providers.anthropic).toEqual({ options: { apiKey: 'user-anthropic' } });
    expect(providers['github-copilot']).toEqual({ name: 'Copilot' });
    // codemie-proxy is the fresh one, not stale
    expect((providers['codemie-proxy'] as { options: { baseURL: string } }).options.baseURL)
      .toBe('http://localhost:9999/');
    expect((providers['codemie-proxy'] as { models: Record<string, unknown> }).models)
      .toHaveProperty('gpt-5-2-2025-12-11');
  });

  it('removes enabled_providers so authenticated opencode providers are not hidden', async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      enabled_providers: ['anthropic', 'codemie-proxy'],
    }));

    const cfg = buildCodeMieConfig();
    await mergeOpenCodeProviders(cfg, userConfigPath);

    // Upstream opencode treats enabled_providers as a hard whitelist. Removing
    // it entirely is what allows providers authenticated via opencode's auth
    // store (e.g. GitHub Copilot) to remain visible in the UI.
    expect('enabled_providers' in cfg).toBe(false);
  });

  it("preserves user's top-level model field when set", async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      model: 'anthropic/claude-sonnet-4-5',
    }));

    const cfg = buildCodeMieConfig();
    await mergeOpenCodeProviders(cfg, userConfigPath);

    expect(cfg.model).toBe('anthropic/claude-sonnet-4-5');
  });

  it("uses CodeMie's computed model when user has no model field", async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      provider: { anthropic: {} },
    }));

    const cfg = buildCodeMieConfig();
    await mergeOpenCodeProviders(cfg, userConfigPath);

    expect(cfg.model).toBe('codemie-proxy/gpt-5-2-2025-12-11');
  });

  it('merges plugin arrays without duplicates', async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      plugin: ['file:///user/plugin.js'],
    }));

    const cfg = buildCodeMieConfig();
    (cfg as Record<string, unknown>).plugin = ['file:///codemie/hooks.js'];
    await mergeOpenCodeProviders(cfg, userConfigPath);

    expect(cfg.plugin).toEqual([
      'file:///codemie/hooks.js',
      'file:///user/plugin.js',
    ]);
  });

  it('passes through extra top-level user keys that CodeMie does not set (mcp, mode)', async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      mcp: { foo: { command: 'foo-server' } },
      mode: 'plan',
    }));

    const cfg = buildCodeMieConfig();
    await mergeOpenCodeProviders(cfg, userConfigPath);

    expect(cfg.mcp).toEqual({ foo: { command: 'foo-server' } });
    expect(cfg.mode).toBe('plan');
  });

  it('removes the whitelist even when user config does not define enabled_providers', async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      provider: { anthropic: {} },
    }));

    const cfg = buildCodeMieConfig();
    await mergeOpenCodeProviders(cfg, userConfigPath);

    expect('enabled_providers' in cfg).toBe(false);
  });

  it("does not let user override codemie-owned top-level keys (e.g. share)", async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      share: 'enabled', // user tries to re-enable share
    }));

    const cfg = buildCodeMieConfig();
    await mergeOpenCodeProviders(cfg, userConfigPath);

    expect(cfg.share).toBe('disabled'); // CodeMie value preserved
  });

  it("preserves user's openai provider when CodeMie did NOT emit one (no Responses-API models)", async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      provider: {
        openai: { options: { apiKey: 'user-openai-key' } },
      },
    }));

    const cfg = buildCodeMieConfig(); // no `openai` key in codemie config
    await mergeOpenCodeProviders(cfg, userConfigPath);

    const providers = cfg.provider as Record<string, unknown>;
    expect(providers.openai).toEqual({ options: { apiKey: 'user-openai-key' } });
  });

  it("replaces user's openai provider when CodeMie DID emit one (Responses-API models present)", async () => {
    writeFileSync(userConfigPath, JSON.stringify({
      provider: {
        openai: { options: { apiKey: 'user-openai-key' } },
      },
    }));

    const cfg = buildCodeMieConfig();
    // Simulate CodeMie emitting its own openai entry (Responses-API path)
    (cfg.provider as Record<string, unknown>).openai = {
      name: 'CodeMie SSO',
      options: { baseURL: 'http://localhost:9999/' },
      models: { 'o3-2025': {} },
    };
    await mergeOpenCodeProviders(cfg, userConfigPath);

    const providers = cfg.provider as Record<string, unknown>;
    // CodeMie wins → user's openai entry is replaced
    expect((providers.openai as { name: string }).name).toBe('CodeMie SSO');
    expect((providers.openai as { options: { baseURL: string } }).options.baseURL)
      .toBe('http://localhost:9999/');
  });

  it('empty user config object still removes the provider whitelist', async () => {
    writeFileSync(userConfigPath, JSON.stringify({}));
    const cfg = buildCodeMieConfig();
    await mergeOpenCodeProviders(cfg, userConfigPath);
    expect('enabled_providers' in cfg).toBe(false);
    expect(cfg.model).toBe('codemie-proxy/gpt-5-2-2025-12-11');
  });
});
