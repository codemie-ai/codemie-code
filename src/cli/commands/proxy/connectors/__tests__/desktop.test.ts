/**
 * Desktop connector tests
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';

import { logger } from '@/utils/logger.js';
import { getClaudeDesktopManagedSettingsPath } from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';

import {
  buildGatewayConfig,
  cloneManagedEntry,
  DEFAULT_MANAGED_MCP_SERVERS,
  describeManagedSettingsOverride,
  fetchClaudeModels,
  getDesktopBaseDir,
  getDesktopConfigPath,
  getManagedMcpStatePath,
  type ManagedMcpServerEntry,
  mapCanonicalToDesktop,
  mergeManagedMcpServers,
  reconcileManagedMcpServers,
  resolveDesktopOAuth,
  selectDesktopClaudeModels,
  selectPreferredClaudeModels,
  summarizeManagedOauthShapes,
  writeDesktopConfig,
} from '../desktop.js';

// Mirrors the real gateway response shape — includes vertex/non-claude/dated
// variants so we exercise the filter and resolver logic together.
const MODEL_LIST_RESPONSE = {
  data: [
    { id: 'claude-sonnet-4-5-20250929' },
    { id: 'claude-4-5-sonnet' },
    { id: 'claude-sonnet-4-6' },
    { id: 'claude-sonnet-4-6-vertex' },
    { id: 'claude-opus-4-5-20251101' },
    { id: 'claude-opus-4-6-20260205' },
    { id: 'claude-opus-4-6-vertex' },
    { id: 'claude-opus-4-7' },
    { id: 'claude-haiku-4-5-20251001' },
    { id: 'gpt-5' },
    { id: 'codemie' },
  ],
};

// Mirrors the backend's structured oauth payload for EPMCDME-14072.
const OAUTH_CONFIG = {
  clientId: 'codemie-mcp-proxy',
  scope: 'openid profile email',
  callbackHost: 'localhost',
  callbackPort: 3118,
  authorizationUrl: 'https://auth.codemie.test/realms/codemie-prod/protocol/openid-connect/auth?kc_idp_hint=epam-oidc&prompt=login',
  tokenUrl: 'https://auth.codemie.test/realms/codemie-prod/protocol/openid-connect/token',
};

describe('buildGatewayConfig', () => {
  it('returns correct gateway config shape', () => {
    expect(buildGatewayConfig('http://localhost:4001', 'codemie-proxy')).toEqual({
      inferenceProvider: 'gateway',
      inferenceGatewayBaseUrl: 'http://localhost:4001',
      inferenceGatewayApiKey: 'codemie-proxy',
      inferenceGatewayAuthScheme: 'bearer',
    });
  });
});

describe('getDesktopBaseDir', () => {
  const originalPlatform = process.platform;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  function simulatePlatform(value: string): void {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  function restoreEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  afterEach(() => {
    simulatePlatform(originalPlatform);
    restoreEnv('LOCALAPPDATA', originalLocalAppData);
    restoreEnv('XDG_CONFIG_HOME', originalXdgConfigHome);
  });

  it('points to Claude-3p on the current platform', () => {
    const dir = getDesktopBaseDir();
    expect(dir).toMatch(/Claude-3p$/);
  });

  it('uses LOCALAPPDATA on windows (simulated)', () => {
    simulatePlatform('win32');
    process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
    expect(getDesktopBaseDir()).toBe(join('C:\\Users\\test\\AppData\\Local', 'Claude-3p'));
  });

  it('uses XDG_CONFIG_HOME on linux (simulated)', () => {
    simulatePlatform('linux');
    process.env.XDG_CONFIG_HOME = join(tmpdir(), 'xdg-config');
    expect(getDesktopBaseDir()).toBe(join(tmpdir(), 'xdg-config', 'Claude-3p'));
  });

  it('falls back to ~/.config on linux when XDG_CONFIG_HOME is unset (simulated)', () => {
    simulatePlatform('linux');
    delete process.env.XDG_CONFIG_HOME;
    expect(getDesktopBaseDir()).toBe(join(homedir(), '.config', 'Claude-3p'));
  });

  // The XDG spec treats an empty value as unset, and requires absolute paths;
  // Electron does the same. Without this, join('', 'Claude-3p') yields the
  // relative path 'Claude-3p' and the gateway key lands in the current
  // directory instead of Claude Desktop's config library.
  it.each([
    ['empty', ''],
    ['relative', '.config'],
    ['relative with a leading dot-slash', './config'],
  ])('ignores a %s XDG_CONFIG_HOME on linux (simulated)', (_label, value) => {
    simulatePlatform('linux');
    process.env.XDG_CONFIG_HOME = value;
    expect(getDesktopBaseDir()).toBe(join(homedir(), '.config', 'Claude-3p'));
  });

  it('never returns a relative base dir on linux, whatever XDG_CONFIG_HOME holds (simulated)', () => {
    simulatePlatform('linux');
    for (const value of ['', ' ', '.', '..', 'relative/path', './x']) {
      process.env.XDG_CONFIG_HOME = value;
      expect(isAbsolute(getDesktopBaseDir())).toBe(true);
    }
  });

  it('still throws on a platform Claude Desktop does not ship for (simulated)', () => {
    simulatePlatform('freebsd');
    expect(() => getDesktopBaseDir()).toThrow('not supported on platform');
  });
});

describe('describeManagedSettingsOverride', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('resolves the managed settings file on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(getClaudeDesktopManagedSettingsPath()).toBe('/etc/claude-desktop/managed-settings.json');
  });

  it.each(['darwin', 'win32'])('reports no plain-file managed source on %s', (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    expect(getClaudeDesktopManagedSettingsPath()).toBeNull();
  });

  it('returns null when the platform has no plain-file managed source', () => {
    expect(describeManagedSettingsOverride(null)).toBeNull();
  });

  it('returns null when the managed settings file does not exist', () => {
    expect(describeManagedSettingsOverride(join(tmpdir(), 'codemie-no-such-managed-settings.json')))
      .toBeNull();
  });

  it('names the file when it exists, because managed settings override local config', async () => {
    const dir = join(tmpdir(), `codemie-managed-settings-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'managed-settings.json');
    await writeFile(file, '{}');
    try {
      const message = describeManagedSettingsOverride(file);
      expect(message).toContain(file);
      expect(message).toMatch(/may have no effect/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('fetchClaudeModels', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const mkHeaders = (ct: string) => ({ get: (h: string) => h === 'content-type' ? ct : null });

  it('returns Claude family ids and excludes vertex / non-claude entries', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mkHeaders('application/json'),
      json: async () => [
        { base_name: 'claude-sonnet-4-5-20250929' },
        { base_name: 'claude-4-5-sonnet' },
        { base_name: 'claude-sonnet-4-6' },
        { base_name: 'claude-opus-4-5-20251101' },
        { base_name: 'claude-opus-4-6-20260205' },
        { base_name: 'claude-opus-4-7' },
        { base_name: 'claude-haiku-4-5-20251001' },
        { base_name: 'claude-opus-4-6-vertex' },
        { base_name: 'gpt-5.5-2026-04-24' },
      ],
    }) as unknown as typeof globalThis.fetch;

    const models = await fetchClaudeModels('http://127.0.0.1:4001', 'codemie-proxy');
    expect(models).toEqual([
      'claude-sonnet-4-5-20250929',
      'claude-4-5-sonnet',
      'claude-sonnet-4-6',
      'claude-opus-4-5-20251101',
      'claude-opus-4-6-20260205',
      'claude-opus-4-7',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('sends Authorization Bearer header with the gateway key', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, headers: mkHeaders('application/json'), json: async () => ({ data: [] }) });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await fetchClaudeModels('http://127.0.0.1:4001', 'my-key');
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer my-key');
  });

  it('throws when fetch fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any;
    await expect(fetchClaudeModels('http://127.0.0.1:4001', 'codemie-proxy'))
      .rejects.toThrow('Local proxy model discovery could not reach');
  });

  it('throws when response is not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as any;
    await expect(fetchClaudeModels('http://127.0.0.1:4001', 'codemie-proxy'))
      .rejects.toThrow('Local proxy model discovery failed');
  });

  it('returns vertex Claude ids when the catalog is vertex-only', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mkHeaders('application/json'),
      json: async () => [
        { base_name: 'gemini-2.5-flash' },
        { base_name: 'claude-sonnet-4-5-vertex' },
        { base_name: 'claude-sonnet-4-6-vertex' },
      ],
    }) as unknown as typeof globalThis.fetch;

    const models = await fetchClaudeModels('http://127.0.0.1:4001', 'codemie-proxy');
    expect(models).toEqual([
      'claude-sonnet-4-5-vertex',
      'claude-sonnet-4-6-vertex',
    ]);
  });

  it('prefers non-vertex Claude ids when both canonical and vertex entries exist', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mkHeaders('application/json'),
      json: async () => [
        { base_name: 'claude-sonnet-4-6' },
        { base_name: 'claude-sonnet-4-6-vertex' },
        { base_name: 'claude-opus-4-6-vertex' },
      ],
    }) as unknown as typeof globalThis.fetch;

    const models = await fetchClaudeModels('http://127.0.0.1:4001', 'codemie-proxy');
    expect(models).toEqual(['claude-sonnet-4-6']);
  });

  it('throws ConfigurationError with re-auth message when response is HTML (Keycloak redirect)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mkHeaders('text/html; charset=utf-8'),
      json: async () => { throw new SyntaxError("Unexpected token '<'"); },
    }) as unknown as typeof globalThis.fetch;

    await expect(fetchClaudeModels('http://127.0.0.1:4001', 'codemie-proxy'))
      .rejects.toThrow('SSO session may have expired');
  });

  it('throws ConfigurationError when response content-type is plain text (not JSON)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mkHeaders('text/plain; charset=utf-8'),
      json: async () => { throw new SyntaxError('not json'); },
    }) as unknown as typeof globalThis.fetch;

    await expect(fetchClaudeModels('http://127.0.0.1:4001', 'codemie-proxy'))
      .rejects.toThrow('SSO session may have expired');
  });

  it('returns models when content-type is application/json (regression)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: mkHeaders('application/json; charset=utf-8'),
      json: async () => ({ data: [{ id: 'claude-sonnet-4-6' }] }),
    }) as unknown as typeof globalThis.fetch;

    const models = await fetchClaudeModels('http://127.0.0.1:4001', 'codemie-proxy');
    expect(models).toContain('claude-sonnet-4-6');
  });
});

describe('selectPreferredClaudeModels', () => {
  const available = [
    'claude-sonnet-4-5-20250929',
    'claude-4-5-sonnet',
    'claude-sonnet-4-6',
    'claude-opus-4-5-20251101',
    'claude-opus-4-6-20260205',
    'claude-opus-4-7',
    'claude-haiku-4-5-20251001',
  ];

  it('returns exact matches when present and dated fallbacks otherwise', () => {
    expect(selectPreferredClaudeModels(available)).toEqual([
      'claude-sonnet-4-6',        // exact
      'claude-opus-4-7',          // exact
      'claude-opus-4-6-20260205', // dated fallback
      'claude-haiku-4-5-20251001',// dated fallback
    ]);
  });

  it('preserves the order of the preferred list', () => {
    const result = selectPreferredClaudeModels(available, ['claude-haiku-4-5', 'claude-opus-4-7']);
    expect(result).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-4-7']);
  });

  it('drops preferred entries with no match', () => {
    expect(selectPreferredClaudeModels(['claude-opus-4-7'], ['claude-opus-4-7', 'claude-imaginary-9-9']))
      .toEqual(['claude-opus-4-7']);
  });

  it('picks the latest dated variant when multiple exist', () => {
    expect(selectPreferredClaudeModels(
      ['claude-opus-4-6-20260101', 'claude-opus-4-6-20260205'],
      ['claude-opus-4-6']
    )).toEqual(['claude-opus-4-6-20260205']);
  });

  it('falls back to the vertex suffix when canonical and dated variants are absent', () => {
    expect(selectPreferredClaudeModels(
      ['claude-sonnet-4-5-vertex', 'claude-sonnet-4-6-vertex'],
      ['claude-sonnet-4-6']
    )).toEqual(['claude-sonnet-4-6-vertex']);
  });
});

describe('selectDesktopClaudeModels', () => {
  it('exposes only Opus 4.8 when the gateway serves it', () => {
    const result = selectDesktopClaudeModels([
      'claude-sonnet-4-6',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6-20260205',
      'claude-haiku-4-5-20251001',
    ]);
    expect(result).toEqual([
      'claude-sonnet-4-6',
      'claude-opus-4-8',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('falls back to the highest available opus when 4.8 is absent', () => {
    const result = selectDesktopClaudeModels([
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'claude-opus-4-6-20260205',
      'claude-haiku-4-5-20251001',
    ]);
    expect(result).toEqual([
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('uses the next opus down when only 4.6 is available', () => {
    expect(selectDesktopClaudeModels(['claude-opus-4-6-20260205']))
      .toEqual(['claude-opus-4-6-20260205']);
  });

  it('keeps a single dated Opus 4.8 over older canonical opus ids', () => {
    expect(selectDesktopClaudeModels([
      'claude-opus-4-8-20260601',
      'claude-opus-4-7',
    ])).toEqual(['claude-opus-4-8-20260601']);
  });

  it('returns no opus entry when the gateway serves none', () => {
    expect(selectDesktopClaudeModels(['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']))
      .toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
  });
});

describe('writeDesktopConfig', () => {
  let baseDir: string;
  let libDir: string;
  let metaPath: string;
  let statePath: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    baseDir = join(tmpdir(), `desktop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    libDir = join(baseDir, 'configLibrary');
    metaPath = join(libDir, '_meta.json');
    statePath = join(baseDir, 'managed-state.json');
    await rm(baseDir, { recursive: true, force: true });
    originalFetch = globalThis.fetch;
    // Default: stub fetch to return our model list so writeDesktopConfig can populate inferenceModels.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (h: string) => h === 'content-type' ? 'application/json' : null },
      json: async () => MODEL_LIST_RESPONSE,
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => { globalThis.fetch = originalFetch; });

  it('creates configLibrary/<UUID>.json + _meta.json when no existing config', async () => {
    const written = await writeDesktopConfig('http://localhost:4001', 'codemie-proxy', baseDir, [], statePath);
    expect(existsSync(libDir)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);
    expect(written.startsWith(libDir)).toBe(true);
    expect(written).toMatch(/[0-9a-f-]{36}\.json$/);

    const config = JSON.parse(await readFile(written, 'utf-8'));
    expect(config.inferenceProvider).toBe('gateway');
    expect(config.inferenceGatewayBaseUrl).toBe('http://localhost:4001');
    expect(config.inferenceGatewayApiKey).toBe('codemie-proxy');
    expect(config.inferenceGatewayAuthScheme).toBe('bearer');

    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
    expect(meta.appliedId).toBeDefined();
    expect(meta.entries).toEqual([{ id: meta.appliedId, name: 'CodeMie Proxy' }]);
    expect(written).toBe(join(libDir, `${meta.appliedId}.json`));
  });

  it('reuses appliedId from existing _meta.json when present', async () => {
    const existingId = 'existing-uuid-1234';
    await mkdir(libDir, { recursive: true });
    await writeFile(metaPath, JSON.stringify({
      appliedId: existingId,
      entries: [{ id: existingId, name: 'Default' }],
    }), 'utf-8');

    const written = await writeDesktopConfig('http://localhost:4001', 'codemie-proxy', baseDir, [], statePath);
    expect(written).toBe(join(libDir, `${existingId}.json`));

    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
    expect(meta.appliedId).toBe(existingId);
    // Entry name is preserved (not changed to "CodeMie Proxy")
    expect(meta.entries[0].name).toBe('Default');
  });

  it('preserves non-inference keys in the config file', async () => {
    const existingId = 'reuse-id';
    await mkdir(libDir, { recursive: true });
    await writeFile(metaPath, JSON.stringify({ appliedId: existingId, entries: [{ id: existingId, name: 'X' }] }), 'utf-8');
    await writeFile(join(libDir, `${existingId}.json`), JSON.stringify({
      someUserPreference: 'keep-me',
      inferenceGatewayBaseUrl: 'http://stale',
    }), 'utf-8');

    const written = await writeDesktopConfig('http://localhost:4001', 'codemie-proxy', baseDir, [], statePath);
    const config = JSON.parse(await readFile(written, 'utf-8'));
    expect(config.someUserPreference).toBe('keep-me');
    expect(config.inferenceGatewayBaseUrl).toBe('http://localhost:4001');
  });

  it('populates inferenceModels with the curated preferred Claude set (single opus)', async () => {
    const written = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, [], statePath);
    const config = JSON.parse(await readFile(written, 'utf-8'));
    expect(JSON.parse(config.inferenceModels)).toEqual([
      { name: 'claude-sonnet-4-6' },
      { name: 'claude-opus-4-7' },
      { name: 'claude-haiku-4-5-20251001' },
    ]);
  });

  it('replaces existing inferenceModels entries — does not merge user-added ones', async () => {
    const existingId = 'reuse-id';
    await mkdir(libDir, { recursive: true });
    await writeFile(metaPath, JSON.stringify({ appliedId: existingId, entries: [{ id: existingId, name: 'X' }] }), 'utf-8');
    await writeFile(join(libDir, `${existingId}.json`), JSON.stringify({
      inferenceModels: [{ name: 'my-custom-model' }, { name: 'claude-sonnet-4-5-20250929' }],
    }), 'utf-8');

    const written = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, [], statePath);
    const config = JSON.parse(await readFile(written, 'utf-8'));
    expect(JSON.parse(config.inferenceModels)).toEqual([
      { name: 'claude-sonnet-4-6' },
      { name: 'claude-opus-4-7' },
      { name: 'claude-haiku-4-5-20251001' },
    ]);
  });

  it('fails fast when discovery returns nothing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (h: string) => h === 'content-type' ? 'application/json' : null },
      json: async () => [],
    }) as unknown as typeof globalThis.fetch;
    await expect(writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, [], statePath))
      .rejects.toThrow('Local proxy did not expose any Claude models');
  });

  it('succeeds with a vertex-only model catalog like a Vertex-only tenant', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: (h: string) => h === 'content-type' ? 'application/json' : null },
      json: async () => [
        { base_name: 'gemini-2.5-flash', deployment_name: 'gemini-2.5-flash' },
        { base_name: 'gemini-2.5-pro', deployment_name: 'gemini-2.5-pro' },
        { base_name: 'claude-sonnet-4-5-vertex', deployment_name: 'claude-sonnet-4-5-vertex' },
        { base_name: 'claude-sonnet-4-6-vertex', deployment_name: 'claude-sonnet-4-6-vertex' },
      ],
    }) as unknown as typeof globalThis.fetch;

    const written = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir);
    const config = JSON.parse(await readFile(written, 'utf-8'));
    expect(JSON.parse(config.inferenceModels)).toEqual([
      { name: 'claude-sonnet-4-6-vertex' },
    ]);
  });

  it('overwrites the four inference keys with new values', async () => {
    const existingId = 'reuse-id';
    await mkdir(libDir, { recursive: true });
    await writeFile(metaPath, JSON.stringify({ appliedId: existingId, entries: [{ id: existingId, name: 'X' }] }), 'utf-8');
    await writeFile(join(libDir, `${existingId}.json`), JSON.stringify({
      inferenceProvider: 'bedrock',
      inferenceGatewayBaseUrl: 'https://old.com',
      inferenceGatewayApiKey: 'old-key',
      inferenceGatewayAuthScheme: 'x-api-key',
    }), 'utf-8');

    const written = await writeDesktopConfig('http://localhost:4002', 'new-key', baseDir, [], statePath);
    const config = JSON.parse(await readFile(written, 'utf-8'));
    expect(config.inferenceProvider).toBe('gateway');
    expect(config.inferenceGatewayBaseUrl).toBe('http://localhost:4002');
    expect(config.inferenceGatewayApiKey).toBe('new-key');
    expect(config.inferenceGatewayAuthScheme).toBe('bearer');
  });

  it('writes org MCP servers and persists managed-state for revocation', async () => {
    const org = [
      { name: 'sample', url: 'https://mcp.example.com/mcp/sample', transport: 'http' as const, oauth: true },
    ];
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    expect(servers.some((s: any) => s.name === 'sample')).toBe(true);
    expect(servers.some((s: any) => s.name === 'Notion')).toBe(true);

    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(state.managedNames).toContain('sample');
    expect(state.managedNames).toContain('Notion');
  });

  it('revokes a managed server removed from the org list on the next run', async () => {
    const org = [
      { name: 'sample', url: 'https://mcp.example.com/mcp/sample', transport: 'http' as const, oauth: true },
    ];
    await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, [], statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    expect(servers.some((s: any) => s.name === 'sample')).toBe(false);
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(state.managedNames).not.toContain('sample');
  });

  it('exposes a default managed-state path under the codemie home', () => {
    expect(getManagedMcpStatePath()).toMatch(/desktop-managed-mcp-state\.json$/);
  });

  it('treats a corrupt managed-state file as empty and still succeeds', async () => {
    await mkdir(join(statePath, '..'), { recursive: true });
    await writeFile(statePath, 'not-json{{{', 'utf-8');
    const org = [
      { name: 'sample', url: 'https://mcp.example.com/mcp/sample', transport: 'http' as const, oauth: true },
    ];
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);
    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    expect(servers.some((s: any) => s.name === 'sample')).toBe(true);
    // corrupt prior state is ignored (treated as []), so the run succeeds and rewrites valid state
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(state.managedNames).toContain('sample');
  });

  it('preserves existing org entries and leaves marker state untouched when the fetch failed (null)', async () => {
    const org = [
      { name: 'sample', url: 'https://mcp.example.com/mcp/sample', transport: 'http' as const, oauth: true },
    ];
    // Run 1: successful fetch persists sample + records it in the sidecar.
    await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);
    const stateBefore = await readFile(statePath, 'utf-8');
    // Run 2: fetch FAILED (null) — sample must survive, sidecar must be unchanged.
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, null, statePath);
    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    expect(servers.some((s: any) => s.name === 'sample')).toBe(true);
    const stateAfter = await readFile(statePath, 'utf-8');
    expect(stateAfter).toBe(stateBefore);
  });

  it('does not duplicate a public default echoed by the org catalog', async () => {
    const org = [
      { name: 'Notion', url: 'https://mcp.notion.com/mcp', transport: 'http' as const, oauth: true },
    ];
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);
    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    expect(servers.filter((s: any) => s.name === 'Notion').length).toBe(1);
  });

  it('writes a structured oauth object into managedMcpServers intact', async () => {
    const org = mapCanonicalToDesktop([
      {
        name: 'onehub_core',
        transport: 'http',
        url: 'https://mcp.example.com/mcp/onehub_core',
        oauth: { ...OAUTH_CONFIG, audience: 'onehub' },
      },
    ]);
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    const onehub = servers.find((s: any) => s.name === 'onehub_core');
    expect(onehub.oauth).toEqual({ ...OAUTH_CONFIG, audience: 'onehub' });
  });

  it('writes oauth: true for a legacy auth enum entry', async () => {
    const org = mapCanonicalToDesktop([
      { name: 'legacy', transport: 'http', url: 'https://mcp.example.com/mcp/legacy', auth: 'oauth' },
    ]);
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    expect(servers.find((s: any) => s.name === 'legacy').oauth).toBe(true);
  });

  it('writes a hand-built entry with the oauth key omitted without inventing one (courier contract)', async () => {
    // Coverage restored: the downgrade fixtures below were rerouted through
    // mapCanonicalToDesktop (which always resolves oauth to a concrete
    // boolean or object), leaving no test for a ManagedMcpServerEntry whose
    // optional `oauth` key is omitted entirely. The CLI is a courier — it
    // must forward that absence, not default it to `false`.
    const org: ManagedMcpServerEntry[] = [
      { name: 'no_oauth_key', url: 'https://mcp.internal.test/mcp/no-oauth-key', transport: 'http' },
    ];
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    const entry = servers.find((s: any) => s.name === 'no_oauth_key');
    expect(entry).toBeDefined();
    expect('oauth' in entry).toBe(false);
  });

  it('lets a backend entry replace the bundled default it collides with by name', async () => {
    const org = [
      { name: 'notion', url: 'https://mcp.internal.test/mcp/notion', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
    ];
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    const notion = servers.filter((s: any) => s.name.toLowerCase() === 'notion');
    expect(notion).toHaveLength(1);
    expect(notion[0].url).toBe('https://mcp.internal.test/mcp/notion');
    expect(notion[0].oauth).toEqual(OAUTH_CONFIG);
  });

  it('lets a backend entry replace the bundled default it collides with by url', async () => {
    const org = [
      { name: 'notion_internal', url: 'https://mcp.notion.com/mcp', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
    ];
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    expect(servers.filter((s: any) => s.url === 'https://mcp.notion.com/mcp')).toHaveLength(1);
    expect(servers.some((s: any) => s.name === 'Notion')).toBe(false);
    expect(servers.find((s: any) => s.name === 'notion_internal').oauth).toEqual(OAUTH_CONFIG);
  });

  it('keeps an org entry that shadowed a bundled default by name when the next fetch fails', async () => {
    const org = [
      { name: 'notion', url: 'https://mcp.internal.corp/notion', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
    ];
    // Run 1: the backend entry shadows the bundled Notion default.
    await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);
    // Run 2: the catalog fetch FAILED (null) — the bundled public Notion must not
    // come back and evict the tenant's internal server.
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, null, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    const notion = servers.filter((s: any) => s.name.toLowerCase() === 'notion');
    expect(notion).toHaveLength(1);
    expect(notion[0].url).toBe('https://mcp.internal.corp/notion');
    expect(notion[0].oauth).toEqual(OAUTH_CONFIG);
    expect(servers.some((s: any) => s.url === 'https://mcp.notion.com/mcp')).toBe(false);
  });

  it('keeps an org entry that shadowed a bundled default by url when the next fetch fails', async () => {
    const org = [
      { name: 'notion_internal', url: 'https://mcp.notion.com/mcp', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
    ];
    await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, null, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    expect(servers.filter((s: any) => s.url === 'https://mcp.notion.com/mcp')).toHaveLength(1);
    const kept = servers.find((s: any) => s.name === 'notion_internal');
    expect(kept?.oauth).toEqual(OAUTH_CONFIG);
    expect(servers.some((s: any) => s.name === 'Notion')).toBe(false);
  });

  it('still seeds every bundled default on a first run whose fetch failed', async () => {
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, null, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    expect(servers.map((s: any) => s.name)).toEqual(['Notion', 'Linear', 'Box', 'Canva', 'Vercel', 'Netlify', 'Miro']);
  });

  it('seeds no bundled default on a failed fetch when the stored managed list cannot be parsed', async () => {
    // CR-005: a malformed stored value is NOT an empty config. Seeding the full
    // default set would let reconcile claim those names and evict whatever the
    // corrupt list actually held — on the very run with the least recourse.
    const existingId = 'reuse-id';
    await mkdir(libDir, { recursive: true });
    await writeFile(metaPath, JSON.stringify({ appliedId: existingId, entries: [{ id: existingId, name: 'X' }] }), 'utf-8');
    await writeFile(join(libDir, `${existingId}.json`), JSON.stringify({
      managedMcpServers: 'not-json{{{',
    }), 'utf-8');

    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, null, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(JSON.parse(written.managedMcpServers)).toEqual([]);
  });

  it('seeds no bundled default on a failed fetch when the stored managed list is not an array', async () => {
    const existingId = 'reuse-id';
    await mkdir(libDir, { recursive: true });
    await writeFile(metaPath, JSON.stringify({ appliedId: existingId, entries: [{ id: existingId, name: 'X' }] }), 'utf-8');
    await writeFile(join(libDir, `${existingId}.json`), JSON.stringify({
      managedMcpServers: { Notion: { url: 'https://mcp.internal.corp/notion' } },
    }), 'utf-8');

    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, null, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(JSON.parse(written.managedMcpServers)).toEqual([]);
  });

  it('forwards a backend entry with no auth verbatim when it collides with a bundled default by url, and logs the downgrade', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // Routed through the real mapper (not a hand-built fixture): production
      // never writes `oauth: undefined` — mapCanonicalToDesktop's
      // resolveDesktopOAuth fallback always resolves to `false`.
      const org = mapCanonicalToDesktop([
        { name: 'notion_internal', transport: 'http', url: 'https://mcp.notion.com/mcp', auth: 'none' },
      ]);
      const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

      const written = JSON.parse(await readFile(configPath, 'utf-8'));
      const servers = JSON.parse(written.managedMcpServers);
      const notion = servers.filter((s: any) => s.url === 'https://mcp.notion.com/mcp');
      expect(notion).toHaveLength(1);
      // Decision 4: the backend still owns the identity of the endpoint...
      expect(notion[0].name).toBe('notion_internal');
      // Decision 1: the CLI is a courier — the backend's published auth (none)
      // is forwarded verbatim, never raised to the displaced default's oauth.
      expect(notion[0].oauth).toBe(false);
      const warned = warnSpy.mock.calls.some(
        ([message]) => typeof message === 'string' && /downgrade/i.test(message),
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('forwards oauth: false verbatim when a backend entry resolves to no auth for the same url', async () => {
    const org = mapCanonicalToDesktop([
      { name: 'notion_internal', transport: 'http', url: 'https://mcp.notion.com/mcp', auth: 'none' },
    ]);
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    const notion = servers.filter((s: any) => s.url === 'https://mcp.notion.com/mcp');
    expect(notion).toHaveLength(1);
    expect(notion[0].oauth).toBe(false);
  });

  it('writes every colliding backend entry verbatim, even when a sibling entry collides by name', async () => {
    // CR-003: two backend entries collide with the same default via different
    // keys — one by name (carrying auth), one by URL (carrying none). Each is
    // still written exactly as the backend published it.
    const org = [
      { name: 'Notion', url: 'https://mcp.internal.test/mcp/notion', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
      { name: 'notion_alt', url: 'https://mcp.notion.com/mcp', transport: 'http' as const },
    ];
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    const publicNotion = servers.filter((s: any) => s.url === 'https://mcp.notion.com/mcp');
    expect(publicNotion).toHaveLength(1);
    expect(publicNotion[0].name).toBe('notion_alt');
    expect(publicNotion[0].oauth).toBeUndefined();
    const internal = servers.find((s: any) => s.url === 'https://mcp.internal.test/mcp/notion');
    expect(internal?.oauth).toEqual(OAUTH_CONFIG);
  });

  it('drops a bundled default that collides by name with a trailing-slash url variant, without reporting a downgrade (name collision only, CR-008)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const org = mapCanonicalToDesktop([
        { name: 'Notion', transport: 'http', url: 'https://mcp.notion.com/mcp/', auth: 'none' },
      ]);
      const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

      const written = JSON.parse(await readFile(configPath, 'utf-8'));
      const servers = JSON.parse(written.managedMcpServers);
      const notionEntries = servers.filter((s: any) => s.name.toLowerCase() === 'notion');
      // The bundled default (exact url, no trailing slash) is displaced by the
      // NAME collision — the backend entry is written verbatim and exactly one
      // entry carries the name.
      expect(notionEntries).toHaveLength(1);
      expect(notionEntries[0].url).toBe('https://mcp.notion.com/mcp/');
      expect(notionEntries[0].oauth).toBe(false);
      // The two urls are the same effective endpoint but compare unequal —
      // sameManagedEndpoint is verbatim/case-sensitive by design; trailing-slash
      // normalization is a known, separately-tracked gap this task does not fix.
      expect(servers.some((s: any) => s.url === 'https://mcp.notion.com/mcp')).toBe(false);
      // A name-only collision at a different endpoint is not an auth downgrade —
      // a default's oauth describes ITS endpoint, not the name.
      const warned = warnSpy.mock.calls.some(
        ([message]) => typeof message === 'string' && /downgrade/i.test(message),
      );
      expect(warned).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps a previously managed internal server when the backend later reports it without auth', async () => {
    // CR-004: the tenant's internal server shares only its NAME with a bundled
    // default. Dropping it because it resolves to no auth would revoke a live
    // server and resolve the trusted name to the public third-party endpoint.
    const withAuth = [
      { name: 'notion', url: 'https://mcp.internal.corp/notion', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
    ];
    await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, withAuth, statePath);
    const withoutAuth = [
      { name: 'notion', url: 'https://mcp.internal.corp/notion', transport: 'http' as const, oauth: false },
    ];
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, withoutAuth, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    const notion = servers.filter((s: any) => s.name.toLowerCase() === 'notion');
    expect(notion).toHaveLength(1);
    expect(notion[0].url).toBe('https://mcp.internal.corp/notion');
    expect(servers.some((s: any) => s.url === 'https://mcp.notion.com/mcp')).toBe(false);
    // A default's oauth describes ITS endpoint, so it is not forced onto a
    // different one that merely reuses the name.
    expect(notion[0].oauth).toBe(false);
  });

  it('warns when a colliding backend entry would have downgraded a bundled default', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const org = [
        { name: 'notion_internal', url: 'https://mcp.notion.com/mcp', transport: 'http' as const },
      ];
      await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);
      const warned = warnSpy.mock.calls.some(
        ([message]) => typeof message === 'string' && /downgrade/i.test(message),
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn about a downgrade when a backend entry only reuses a bundled default name at a different endpoint', async () => {
    // Companion to 'keeps a previously managed internal server...' above,
    // which covers the write behavior for this shape — this covers the log.
    // A default's oauth describes ITS endpoint, not its name: reusing the
    // name at a different, internal endpoint is the ordinary case (a
    // tenant's own "notion" server) and must never be reported as an auth
    // downgrade.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const org = mapCanonicalToDesktop([
        { name: 'notion', transport: 'http', url: 'https://mcp.internal.corp/notion', auth: 'none' },
      ]);
      await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);
      const warned = warnSpy.mock.calls.some(
        ([message]) => typeof message === 'string' && /downgrade/i.test(message),
      );
      expect(warned).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('records a single downgrade with the endpoint-scoped payload when a backend entry collides by url', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const org = mapCanonicalToDesktop([
        { name: 'notion_internal', transport: 'http', url: 'https://mcp.notion.com/mcp', auth: 'none' },
      ]);
      await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);
      const record = warnSpy.mock.calls.find(
        ([message]) => typeof message === 'string' && /downgrade/i.test(message),
      )?.[1] as any;
      expect(record).toBeDefined();
      expect(record.oauthDowngradeCount).toBe(1);
      expect(record.sourceBundledDefaults).toEqual(['Notion']);
      expect(record.downgradedBackendEntries).toEqual(['notion_internal']);
      expect(record.downgradedUrls).toEqual(['https://mcp.notion.com/mcp']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logs the oauth shape of the servers it writes, not of the candidate set', async () => {
    // CR-006: on a failed fetch over a config that already holds every default,
    // the candidate set is empty while seven entries are written. A summary taken
    // over the candidate set reports zero configured beside a count of seven.
    await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, [], statePath);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, null, statePath);
      const record = infoSpy.mock.calls.find(
        ([message]) => typeof message === 'string' && message.includes('Preparing Claude Desktop config payload'),
      )?.[1] as any;
      expect(record).toBeDefined();
      expect(record.managedMcpServerCount).toBe(7);
      expect(record.oauthFlaggedCount).toBe(7);
      expect(
        record.oauthConfiguredCount + record.oauthFlaggedCount + record.noAuthCount,
      ).toBe(record.managedMcpServerCount);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('reports a displaced default for a name-only collision, with no downgrade warn', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // Same fixture as 'lets a backend entry replace the bundled default it
      // collides with by name': the backend reuses Notion's name at a
      // different internal url — a name-only collision.
      const org = [
        { name: 'notion', url: 'https://mcp.internal.test/mcp/notion', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
      ];
      await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);
      const record = infoSpy.mock.calls.find(
        ([message]) => typeof message === 'string' && message.includes('Preparing Claude Desktop config payload'),
      )?.[1] as any;
      expect(record).toBeDefined();
      expect(record.displacedDefaults).toEqual(['Notion']);
      expect(record.displacedDefaultCount).toBe(1);
      // Pin the pairing: a name-only collision is displacement without a
      // downgrade warn (that warn stays scoped to same-endpoint collisions).
      const warned = warnSpy.mock.calls.some(
        ([message]) => typeof message === 'string' && /downgrade/i.test(message),
      );
      expect(warned).toBe(false);
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('reports a displaced default for the trailing-slash url variant — the only signal for this silent case', async () => {
    // Both review lenses called this shape silent: the backend entry
    // displaces the bundled Notion default by NAME (case-insensitive), but
    // its url differs from the default's only by a trailing slash, so
    // sameManagedEndpoint (verbatim, case-sensitive comparison) does not
    // treat it as a same-endpoint collision — no downgrade warn fires.
    // displacedDefaults is now the only record that an OAuth-bearing default
    // disappeared. The url near-miss itself (that these are the same
    // effective endpoint) is a separately-tracked, pre-existing gap this
    // task does not fix.
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      const org = mapCanonicalToDesktop([
        { name: 'Notion', transport: 'http', url: 'https://mcp.notion.com/mcp/', auth: 'none' },
      ]);
      await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);
      const record = infoSpy.mock.calls.find(
        ([message]) => typeof message === 'string' && message.includes('Preparing Claude Desktop config payload'),
      )?.[1] as any;
      expect(record).toBeDefined();
      expect(record.displacedDefaults).toEqual(['Notion']);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('reports no displaced defaults when the org catalog collides with nothing', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      const org = [
        { name: 'onehub_core', url: 'https://mcp.internal.test/mcp/onehub_core', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
      ];
      await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);
      const record = infoSpy.mock.calls.find(
        ([message]) => typeof message === 'string' && message.includes('Preparing Claude Desktop config payload'),
      )?.[1] as any;
      expect(record).toBeDefined();
      expect(record.displacedDefaultCount).toBe(0);
      expect(record.displacedDefaults).toEqual([]);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('keeps non-colliding bundled defaults, still ordered before org entries', async () => {
    const org = [
      { name: 'onehub_core', url: 'https://mcp.internal.test/mcp/onehub_core', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
    ];
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    const names = servers.map((s: any) => s.name);
    expect(names.slice(0, 7)).toEqual(['Notion', 'Linear', 'Box', 'Canva', 'Vercel', 'Netlify', 'Miro']);
    expect(names[7]).toBe('onehub_core');
  });
});

describe('mapCanonicalToDesktop', () => {
  it('maps remote oauth/none entries and sets the oauth boolean', () => {
    const result = mapCanonicalToDesktop([
      { name: 'sample', transport: 'http', url: 'https://mcp.example.com/mcp/sample', auth: 'oauth' },
      { name: 'plain', transport: 'sse', url: 'https://x/sse', auth: 'none' },
    ]);
    expect(result).toEqual([
      { name: 'sample', url: 'https://mcp.example.com/mcp/sample', transport: 'http', oauth: true },
      { name: 'plain', url: 'https://x/sse', transport: 'sse', oauth: false },
    ]);
  });

  it('drops entries Claude Desktop cannot represent (stdio / missing url / bad name)', () => {
    const result = mapCanonicalToDesktop([
      { name: 'local', transport: 'stdio' },
      { name: 'nourl', transport: 'http' },
      { name: 'bad name', transport: 'http', url: 'https://x' },
      { name: 'ok', transport: 'http', url: 'https://ok' },
    ]);
    expect(result).toEqual([{ name: 'ok', url: 'https://ok', transport: 'http', oauth: false }]);
  });

  it('forwards a structured oauth object to the Desktop entry', () => {
    const result = mapCanonicalToDesktop([
      { name: 'onehub_core', transport: 'http', url: 'https://mcp.example.com/mcp/onehub_core', oauth: OAUTH_CONFIG },
    ]);
    expect(result).toEqual([
      {
        name: 'onehub_core',
        url: 'https://mcp.example.com/mcp/onehub_core',
        transport: 'http',
        oauth: OAUTH_CONFIG,
      },
    ]);
  });

  it('never writes oauth: false for an entry that supplied oauth config', () => {
    const [mapped] = mapCanonicalToDesktop([
      { name: 'onehub_core', transport: 'http', url: 'https://mcp.example.com/mcp/onehub_core', oauth: OAUTH_CONFIG },
    ]);
    expect(mapped.oauth).not.toBe(false);
  });
});

describe('resolveDesktopOAuth', () => {
  it('forwards a valid oauth object as a copy', () => {
    const entry = { name: 'onehub_core', transport: 'http' as const, url: 'https://x', oauth: OAUTH_CONFIG };
    const resolved = resolveDesktopOAuth(entry);
    expect(resolved).toEqual(OAUTH_CONFIG);
    expect(resolved).not.toBe(OAUTH_CONFIG);
  });

  it('preserves unknown keys inside the oauth object', () => {
    const oauth = { ...OAUTH_CONFIG, audience: 'onehub', pkce: true };
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x', oauth })).toEqual(oauth);
  });

  it('passes the boolean shapes through unchanged', () => {
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x', oauth: true })).toBe(true);
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x', oauth: false })).toBe(false);

    // the boolean rows must beat the legacy auth enum
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x', oauth: false, auth: 'oauth' })).toBe(false);
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x', oauth: true, auth: 'none' })).toBe(true);
  });

  it('falls back to the legacy auth enum', () => {
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x', auth: 'oauth' })).toBe(true);
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x', auth: 'none' })).toBe(false);
  });

  it('prefers the oauth object over the legacy enum when both are present', () => {
    expect(resolveDesktopOAuth({
      name: 'a', transport: 'http', url: 'https://x', auth: 'none', oauth: OAUTH_CONFIG,
    })).toEqual(OAUTH_CONFIG);
  });

  it('returns false when the entry carries neither field (unchanged behavior)', () => {
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x' })).toBe(false);
  });
});

describe('getDesktopConfigPath', () => {
  let baseDir: string;
  let libDir: string;

  beforeEach(async () => {
    baseDir = join(tmpdir(), `desktop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    libDir = join(baseDir, 'configLibrary');
    await rm(baseDir, { recursive: true, force: true });
  });

  it('returns a fresh UUID path when _meta.json does not exist', async () => {
    const path = await getDesktopConfigPath(baseDir);
    expect(path.startsWith(libDir)).toBe(true);
    expect(path).toMatch(/[0-9a-f-]{36}\.json$/);
  });

  it('returns the appliedId path when _meta.json exists', async () => {
    await mkdir(libDir, { recursive: true });
    await writeFile(join(libDir, '_meta.json'), JSON.stringify({ appliedId: 'abc-123', entries: [] }), 'utf-8');
    expect(await getDesktopConfigPath(baseDir)).toBe(join(libDir, 'abc-123.json'));
  });
});

describe('reconcileManagedMcpServers', () => {
  const managed = [
    { name: 'sample', url: 'https://mcp.example.com/mcp/sample', transport: 'http' as const, oauth: true },
  ];

  it('adds managed entries and preserves unrelated user entries', () => {
    const existing = [{ name: 'mine', url: 'https://mine', transport: 'http', oauth: true }];
    const { servers, managedNames } = reconcileManagedMcpServers(existing, managed, []);
    expect(managedNames).toEqual(['sample']);
    expect(servers).toEqual([
      { name: 'sample', url: 'https://mcp.example.com/mcp/sample', transport: 'http', oauth: true },
      { name: 'mine', url: 'https://mine', transport: 'http', oauth: true },
    ]);
  });

  it('supersedes a colliding user entry (by name or url)', () => {
    const existing = [
      { name: 'sample', url: 'https://old-sample', transport: 'http', oauth: true, source: 'user' },
    ];
    const { servers } = reconcileManagedMcpServers(existing, managed, []);
    expect(servers).toEqual([
      { name: 'sample', url: 'https://mcp.example.com/mcp/sample', transport: 'http', oauth: true },
    ]);
  });

  it('supersedes a user entry that collides only by url (non-colliding name)', () => {
    const existing = [
      { name: 'sample-legacy', url: 'https://mcp.example.com/mcp/sample', transport: 'http', oauth: true },
      { name: 'mine', url: 'https://mine', transport: 'http', oauth: true },
    ];
    const { servers } = reconcileManagedMcpServers(existing, managed, []);
    // sample-legacy is dropped via the URL-collision branch (its name does not
    // collide with the managed set); the managed sample replaces it; mine stays.
    expect(servers).toEqual([
      { name: 'sample', url: 'https://mcp.example.com/mcp/sample', transport: 'http', oauth: true },
      { name: 'mine', url: 'https://mine', transport: 'http', oauth: true },
    ]);
  });

  it('revokes a previously-managed entry that is no longer managed', () => {
    const existing = [
      { name: 'sample', url: 'https://mcp.example.com/mcp/sample', transport: 'http', oauth: true, source: 'user' },
      { name: 'mine', url: 'https://mine', transport: 'http', oauth: true },
    ];
    const { servers, managedNames } = reconcileManagedMcpServers(existing, [], ['sample']);
    expect(managedNames).toEqual([]);
    expect(servers).toEqual([{ name: 'mine', url: 'https://mine', transport: 'http', oauth: true }]);
  });

  it('drops entries with invalid names', () => {
    const existing = [{ name: 'bad name', url: 'https://b', transport: 'http' }];
    const { servers } = reconcileManagedMcpServers(existing, [], []);
    expect(servers).toEqual([]);
  });

  it('drops a nameless entry whose url collides with a managed entry', () => {
    const existing = [{ url: 'https://mcp.example.com/mcp/sample', transport: 'http' }];
    const { servers } = reconcileManagedMcpServers(existing, managed, []);
    expect(servers).toEqual([
      { name: 'sample', url: 'https://mcp.example.com/mcp/sample', transport: 'http', oauth: true },
    ]);
  });

  it('keeps a nameless entry whose url does NOT collide with any managed entry', () => {
    const existing = [{ url: 'https://something-else', transport: 'http' }];
    const { servers } = reconcileManagedMcpServers(existing, managed, []);
    expect(servers).toEqual([
      { name: 'sample', url: 'https://mcp.example.com/mcp/sample', transport: 'http', oauth: true },
      { url: 'https://something-else', transport: 'http' },
    ]);
  });

  it('does not alias the nested oauth object of a managed entry', () => {
    const managed = [
      { name: 'onehub_core', url: 'https://mcp.example.com/mcp/onehub_core', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
    ];
    const { servers } = reconcileManagedMcpServers([], managed);

    (servers[0] as any).oauth.clientId = 'mutated';

    // The bundled defaults carry only boolean oauth, so proving the nested
    // object is not shared still needs this hand-built fixture.
    expect(managed[0].oauth.clientId).toBe('codemie-mcp-proxy');

    // Prove the guard protects DEFAULT_MANAGED_MCP_SERVERS itself, not just a
    // locally-built stand-in for it: merging the real bundled defaults with an
    // empty org catalog must not return the constant's own entry objects.
    // DEFAULT_MANAGED_MCP_SERVERS is a process-lifetime constant; sharing a
    // nested object with it would corrupt every later run in the process.
    const { managed: mergedDefaults } = mergeManagedMcpServers(DEFAULT_MANAGED_MCP_SERVERS, []);
    expect(mergedDefaults[0]).not.toBe(DEFAULT_MANAGED_MCP_SERVERS[0]);
  });
});

describe('cloneManagedEntry', () => {
  it('copies the nested oauth object rather than sharing it', () => {
    const entry = { name: 'a', url: 'https://x', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } };
    const copy = cloneManagedEntry(entry);

    expect(copy).toEqual(entry);
    expect(copy.oauth).not.toBe(entry.oauth);
  });

  it('leaves a boolean oauth flag as-is', () => {
    const entry = { name: 'Notion', url: 'https://mcp.notion.com/mcp', transport: 'http' as const, oauth: true };
    expect(cloneManagedEntry(entry)).toEqual(entry);
  });

  it('handles an entry with no oauth field', () => {
    const entry = { name: 'a', url: 'https://x' };
    const copy = cloneManagedEntry(entry);
    expect(copy).toEqual(entry);
    expect(copy).not.toBe(entry);
  });
});

describe('summarizeManagedOauthShapes', () => {
  it('counts object, boolean and absent oauth shapes', () => {
    expect(summarizeManagedOauthShapes([
      { name: 'obj', url: 'https://a', oauth: { ...OAUTH_CONFIG } },
      { name: 'flag', url: 'https://b', oauth: true },
      { name: 'off', url: 'https://c', oauth: false },
      { name: 'absent', url: 'https://d' },
    ])).toEqual({ oauthConfigured: 1, oauthFlagged: 1, noAuth: 2 });
  });

  it('returns zeroes for a failed fetch (null) and for an empty list', () => {
    expect(summarizeManagedOauthShapes(null)).toEqual({ oauthConfigured: 0, oauthFlagged: 0, noAuth: 0 });
    expect(summarizeManagedOauthShapes([])).toEqual({ oauthConfigured: 0, oauthFlagged: 0, noAuth: 0 });
  });
});
