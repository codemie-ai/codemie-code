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

  it('uses APPDATA on windows (simulated)', () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    expect(getDesktopBaseDir()).toContain('Claude-3p');
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    delete process.env.APPDATA;
  });
});

describe('fetchClaudeModels', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns Claude family ids and excludes vertex / non-claude entries', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => MODEL_LIST_RESPONSE,
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

  it('returns [] when fetch fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any;
    expect(await fetchClaudeModels('http://127.0.0.1:4001', 'codemie-proxy')).toEqual([]);
  });

  it('returns [] when response is not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as any;
    expect(await fetchClaudeModels('http://127.0.0.1:4001', 'codemie-proxy')).toEqual([]);
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
      'claude-opus-4-7',          // exact
      'claude-opus-4-6-20260205', // dated fallback
      'claude-sonnet-4-6',        // exact
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
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    baseDir = join(tmpdir(), `desktop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    libDir = join(baseDir, 'configLibrary');
    metaPath = join(libDir, '_meta.json');
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
    const written = await writeDesktopConfig('http://localhost:4001', 'codemie-proxy', baseDir);
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

    const written = await writeDesktopConfig('http://localhost:4001', 'codemie-proxy', baseDir);
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

    const written = await writeDesktopConfig('http://localhost:4001', 'codemie-proxy', baseDir);
    const config = JSON.parse(await readFile(written, 'utf-8'));
    expect(config.someUserPreference).toBe('keep-me');
    expect(config.inferenceGatewayBaseUrl).toBe('http://localhost:4001');
  });

  it('populates inferenceModels with the curated preferred Claude set', async () => {
    const written = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir);
    const config = JSON.parse(await readFile(written, 'utf-8'));
    expect(config.inferenceModels).toEqual([
      { name: 'claude-opus-4-7' },
      { name: 'claude-opus-4-6-20260205' },
      { name: 'claude-sonnet-4-6' },
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

    const written = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir);
    const config = JSON.parse(await readFile(written, 'utf-8'));
    expect(config.inferenceModels).toEqual([
      { name: 'claude-opus-4-7' },
      { name: 'claude-opus-4-6-20260205' },
      { name: 'claude-sonnet-4-6' },
      { name: 'claude-haiku-4-5-20251001' },
    ]);
  });

  it('omits inferenceModels when discovery returns nothing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }) as any;
    const written = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir);
    const config = JSON.parse(await readFile(written, 'utf-8'));
    expect(config.inferenceModels).toBeUndefined();
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

    const written = await writeDesktopConfig('http://localhost:4002', 'new-key', baseDir);
    const config = JSON.parse(await readFile(written, 'utf-8'));
    expect(config.inferenceProvider).toBe('gateway');
    expect(config.inferenceGatewayBaseUrl).toBe('http://localhost:4002');
    expect(config.inferenceGatewayApiKey).toBe('new-key');
    expect(config.inferenceGatewayAuthScheme).toBe('bearer');
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
