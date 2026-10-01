import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const state = vi.hoisted(() => ({ dir: '' }));
const fetchLatest = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('../paths.js', () => ({
  getCodemiePath: (name: string) => join(state.dir, name),
}));
vi.mock('../npm-registry.js', () => ({ fetchLatestVersionFromRegistry: fetchLatest }));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));

import { getCachedLatestVersion } from '../version-cache.js';

const PKG = '@openai/codex';
const HOUR = 60 * 60 * 1000;
const cacheFile = () => join(state.dir, 'version-cache.json');

async function seedCache(version: string, ageMs: number): Promise<void> {
  const fetchedAt = new Date(Date.now() - ageMs).toISOString();
  await writeFile(cacheFile(), JSON.stringify({ version: 1, packages: { [PKG]: { version, fetchedAt } } }), 'utf-8');
}

describe('getCachedLatestVersion', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    state.dir = await mkdtemp(join(tmpdir(), 'codemie-version-cache-'));
  });

  afterEach(async () => {
    await rm(state.dir, { recursive: true, force: true });
  });

  it('serves a fresh entry without a registry request', async () => {
    await seedCache('0.150.0', 1 * HOUR);

    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.150.0');
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it('refreshes an expired entry from the registry and persists the new value', async () => {
    await seedCache('0.150.0', 25 * HOUR);
    fetchLatest.mockResolvedValue('0.160.0');

    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.160.0');
    expect(fetchLatest).toHaveBeenCalledWith(PKG, { timeoutMs: 3000 });
    const saved = JSON.parse(await readFile(cacheFile(), 'utf-8'));
    expect(saved.packages[PKG].version).toBe('0.160.0');
  });

  it('returns null, not the expired entry, when the lookup fails, and logs it', async () => {
    await seedCache('0.150.0', 25 * HOUR);
    fetchLatest.mockResolvedValue(null);

    await expect(getCachedLatestVersion(PKG)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[version-cache] live version lookup failed',
      expect.objectContaining({ packageName: PKG })
    );
  });

  it('treats a fetchedAt in the future as stale rather than fresh forever', async () => {
    await seedCache('0.150.0', -48 * HOUR);
    fetchLatest.mockResolvedValue('0.160.0');

    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.160.0');
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('still returns the fetched version when the cache cannot be written', async () => {
    // A directory where the cache file should be makes the write fail.
    await mkdir(cacheFile());
    fetchLatest.mockResolvedValue('0.160.0');

    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.160.0');
    expect(warn).toHaveBeenCalledWith(
      '[version-cache] failed to persist lookup result',
      expect.objectContaining({ packageName: PKG })
    );
  });

  it('treats a registry answer that is not a version as a failure, never as a cached version', async () => {
    fetchLatest.mockResolvedValue('<html>proxy login</html>');

    await expect(getCachedLatestVersion(PKG)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[version-cache] live version lookup failed',
      expect.objectContaining({ reason: 'unparsable registry response' })
    );
    const saved = JSON.parse(await readFile(cacheFile(), 'utf-8'));
    expect(saved.packages[PKG]).toBeUndefined();
  });

  it('passes a prerelease string through unchanged so the resolver can reject it', async () => {
    fetchLatest.mockResolvedValue('0.161.0-beta.1');

    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.161.0-beta.1');
  });

  it.each([
    ['packages is null', { version: 1, packages: null }],
    ['packages is an array', { version: 1, packages: [] }],
    ['an entry has the wrong shape', { version: 1, packages: { [PKG]: { version: 42 } } }],
    ['the file is not valid JSON (e.g. a torn write)', '{"version":1,"pack'],
  ])('recovers when %s, and heals the file on the next write', async (_label, content) => {
    await writeFile(cacheFile(), typeof content === 'string' ? content : JSON.stringify(content), 'utf-8');
    fetchLatest.mockResolvedValue('0.160.0');

    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.160.0');
    const saved = JSON.parse(await readFile(cacheFile(), 'utf-8'));
    expect(saved.packages[PKG].version).toBe('0.160.0');
  });

  it('skips lookups for 10 minutes after a failure, then retries', async () => {
    fetchLatest.mockResolvedValueOnce(null).mockResolvedValueOnce('0.160.0');

    await expect(getCachedLatestVersion(PKG)).resolves.toBeNull();
    // A launch right after the failure doesn't wait for the registry again.
    await expect(getCachedLatestVersion(PKG)).resolves.toBeNull();
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    // Age the recorded failure past the backoff window.
    const saved = JSON.parse(await readFile(cacheFile(), 'utf-8'));
    saved.failures[PKG] = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await writeFile(cacheFile(), JSON.stringify(saved), 'utf-8');

    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.160.0');
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(cacheFile(), 'utf-8')).failures[PKG]).toBeUndefined();
  });

  it('retries right away after a failure when the caller bypasses the cache', async () => {
    fetchLatest.mockResolvedValueOnce(null).mockResolvedValueOnce('0.160.0');

    await expect(getCachedLatestVersion(PKG)).resolves.toBeNull();
    await expect(getCachedLatestVersion(PKG, { bypassCache: true })).resolves.toBe('0.160.0');
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });
});
