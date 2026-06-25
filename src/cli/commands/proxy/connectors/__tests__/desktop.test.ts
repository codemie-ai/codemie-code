/**
 * Desktop connector tests
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';

import {
  buildGatewayConfig,
  fetchClaudeModels,
  getDesktopBaseDir,
  getDesktopConfigPath,
  getManagedMcpStatePath,
  mapCanonicalToDesktop,
  reconcileManagedMcpServers,
  selectPreferredClaudeModels,
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
  it.skipIf(process.platform === 'linux')('points to Claude-3p on the current platform', () => {
    const dir = getDesktopBaseDir();
    expect(dir).toMatch(/Claude-3p$/);
  });

  it.runIf(process.platform === 'linux')('throws ConfigurationError on linux', () => {
    expect(() => getDesktopBaseDir()).toThrow('not supported on platform');
  });

  it('uses LOCALAPPDATA on windows (simulated)', () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
    expect(getDesktopBaseDir()).toBe(join('C:\\Users\\test\\AppData\\Local', 'Claude-3p'));
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    delete process.env.LOCALAPPDATA;
  });
});

describe('fetchClaudeModels', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns Claude family ids and excludes vertex / non-claude entries', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
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
    }) as any;

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
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    globalThis.fetch = fetchSpy as any;

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
      json: async () => MODEL_LIST_RESPONSE,
    }) as any;
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

  it('populates inferenceModels with the curated preferred Claude set', async () => {
    const written = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, [], statePath);
    const config = JSON.parse(await readFile(written, 'utf-8'));
    expect(JSON.parse(config.inferenceModels)).toEqual([
      { name: 'claude-sonnet-4-6' },
      { name: 'claude-opus-4-7' },
      { name: 'claude-opus-4-6-20260205' },
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
      { name: 'claude-opus-4-6-20260205' },
      { name: 'claude-haiku-4-5-20251001' },
    ]);
  });

  it('fails fast when discovery returns nothing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] }) as any;
    await expect(writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, [], statePath))
      .rejects.toThrow('Local proxy did not expose any Claude models');
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
});
