/**
 * Plugin manifest parser + plugin cache contract tests.
 *
 * Pins today's behavior of:
 *  - src/plugins/core/manifest-parser.ts  (parseManifest, expand*, hasManifest)
 *  - src/plugins/core/plugin-cache.ts     (install/list/remove/settings/isCached)
 *
 * All filesystem access is isolated to unique mkdtemp dirs. The plugin cache
 * reads CODEMIE_HOME (via getCodemiePath), so we point it at a throwaway dir
 * per-suite and restore + remove everything afterwards. No network, no exec,
 * no real ~/.codemie access.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  parseManifest,
  hasManifest,
  expandPluginRoot,
  expandPluginRootDeep,
} from '../core/manifest-parser.js';

// ---------------------------------------------------------------------------
// Shared temp-dir helpers
// ---------------------------------------------------------------------------

let workDir: string;

/** Create a plugin dir with a .claude-plugin/plugin.json manifest. */
function makePlugin(
  name: string,
  manifest: unknown,
  opts: { path?: string; extraFile?: boolean } = {},
): string {
  const dir = join(workDir, name);
  const manifestPath = opts.path ?? '.claude-plugin/plugin.json';
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  const full = join(dir, manifestPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  if (opts.extraFile) writeFileSync(join(dir, 'file.txt'), 'content');
  return dir;
}

/** Create a bare directory (no manifest) with the given basename. */
function makeBareDir(name: string): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ===========================================================================
// manifest-parser.ts
// ===========================================================================

describe('manifest-parser: parseManifest', () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'mp-parse-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('parses a valid manifest and preserves fields', async () => {
    const dir = makePlugin('good', {
      name: 'my-plugin',
      version: '1.0.0',
      description: 'hi',
      commands: 'commands',
      keywords: ['a', 'b'],
    });
    const manifest = await parseManifest(dir);
    expect(manifest.name).toBe('my-plugin');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.description).toBe('hi');
    expect(manifest.commands).toBe('commands');
    expect(manifest.keywords).toEqual(['a', 'b']);
  });

  it('expands ${CLAUDE_PLUGIN_ROOT} in nested string values against the plugin dir', async () => {
    const dir = makePlugin('exp', {
      name: 'exp',
      mcpServers: { command: '${CLAUDE_PLUGIN_ROOT}/bin' },
    });
    const manifest = await parseManifest(dir);
    // Expansion uses the absolute plugin dir as the root. The parser joins with a
    // forward slash, so normalize both sides for Windows path separators.
    const command = (manifest.mcpServers as { command: string }).command;
    expect(command.replace(/\\/g, '/')).toBe(join(dir, 'bin').replace(/\\/g, '/'));
  });

  // POSIX-only: validateRelativePaths rejects paths starting with '/' or '\\'.
  // After expansion the plugin dir is '/tmp/...' on POSIX (rejected) but 'C:\\...'
  // on Windows, which this check does not classify as absolute — so this
  // "becomes absolute after expansion" case cannot trigger on Windows.
  it.skipIf(process.platform === 'win32')('rejects a path field that becomes absolute AFTER ${CLAUDE_PLUGIN_ROOT} expansion', async () => {
    // Documented quirk: expansion happens before relative-path validation, so a
    // commands field prefixed with ${CLAUDE_PLUGIN_ROOT} expands to an absolute
    // path and then fails validateRelativePaths.
    const dir = makePlugin('expcmd', {
      name: 'expcmd',
      commands: '${CLAUDE_PLUGIN_ROOT}/commands',
    });
    await expect(parseManifest(dir)).rejects.toThrow(/must use relative paths/);
  });

  it('throws when required "name" is missing', async () => {
    const dir = makePlugin('noname', { version: '1' });
    await expect(parseManifest(dir)).rejects.toThrow(/must have a "name" field/);
  });

  it('throws when "name" is not kebab-case', async () => {
    const dir = makePlugin('badname', { name: 'Bad_Name' });
    await expect(parseManifest(dir)).rejects.toThrow(/kebab-case/);
  });

  it('throws on invalid JSON', async () => {
    const dir = makePlugin('badjson', '{ not json ');
    await expect(parseManifest(dir)).rejects.toThrow(/Invalid JSON in plugin manifest/);
  });

  it('throws when the manifest root is a JSON array', async () => {
    const dir = makePlugin('arr', '[1,2,3]');
    await expect(parseManifest(dir)).rejects.toThrow(/must be a JSON object/);
  });

  it('rejects absolute (leading "/") path fields', async () => {
    const dir = makePlugin('abs', { name: 'abs', agents: ['/abs/path'] });
    await expect(parseManifest(dir)).rejects.toThrow(/must use relative paths.*absolute/);
  });

  it('rejects backslash-absolute path fields', async () => {
    const dir = makePlugin('winabs', { name: 'winabs', skills: '\\win\\abs' });
    await expect(parseManifest(dir)).rejects.toThrow(/must use relative paths/);
  });

  it('prefers .claude-plugin/plugin.json over a root plugin.json', async () => {
    const dir = makePlugin('prio', { name: 'from-claude-plugin' });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'from-root' }));
    const manifest = await parseManifest(dir);
    expect(manifest.name).toBe('from-claude-plugin');
  });

  it('falls back to a root plugin.json when .claude-plugin is absent', async () => {
    const dir = makeBareDir('rootonly');
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'root-only' }));
    const manifest = await parseManifest(dir);
    expect(manifest.name).toBe('root-only');
  });

  it('derives a kebab-case name from the directory when no manifest exists', async () => {
    const dir = makeBareDir('My_Fancy Plugin!!');
    const manifest = await parseManifest(dir);
    expect(manifest).toEqual({ name: 'my-fancy-plugin' });
  });

  it('throws when a name cannot be derived from the directory', async () => {
    const dir = makeBareDir('@@@');
    await expect(parseManifest(dir)).rejects.toThrow(/Cannot derive valid plugin name/);
  });
});

describe('manifest-parser: hasManifest', () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'mp-has-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns true when a manifest file is present', () => {
    const dir = makePlugin('withm', { name: 'withm' });
    expect(hasManifest(dir)).toBe(true);
  });

  it('returns false for a bare directory', () => {
    const dir = makeBareDir('bare');
    expect(hasManifest(dir)).toBe(false);
  });
});

describe('manifest-parser: expandPluginRoot / expandPluginRootDeep', () => {
  it('replaces every ${CLAUDE_PLUGIN_ROOT} occurrence', () => {
    expect(expandPluginRoot('a ${CLAUDE_PLUGIN_ROOT}/x ${CLAUDE_PLUGIN_ROOT}', 'ROOT')).toBe(
      'a ROOT/x ROOT',
    );
  });

  it('leaves strings without the placeholder untouched', () => {
    expect(expandPluginRoot('no placeholder here', 'ROOT')).toBe('no placeholder here');
  });

  it('recurses through objects and arrays, leaving non-strings intact', () => {
    const input = { a: '${CLAUDE_PLUGIN_ROOT}/y', b: [{ c: '${CLAUDE_PLUGIN_ROOT}' }], n: 5, z: null };
    expect(expandPluginRootDeep(input, 'R')).toEqual({ a: 'R/y', b: [{ c: 'R' }], n: 5, z: null });
  });

  it('returns primitives unchanged', () => {
    expect(expandPluginRootDeep(42, 'R')).toBe(42);
    expect(expandPluginRootDeep(null, 'R')).toBe(null);
  });
});

// ===========================================================================
// plugin-cache.ts  (uses CODEMIE_HOME -> temp dir)
// ===========================================================================

describe('plugin-cache', () => {
  let home: string;
  let srcRoot: string;
  let prevHome: string | undefined;
  // Loaded lazily after CODEMIE_HOME is set (module reads it at call time,
  // but we keep the import fresh per suite via dynamic import).
  let cache: typeof import('../core/plugin-cache.js');

  /** Build a source plugin dir (outside the cache) with a manifest + payload. */
  function makeSource(name: string, manifest: Record<string, unknown>): string {
    const dir = join(srcRoot, name);
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin/plugin.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'payload.txt'), 'content');
    return dir;
  }

  beforeEach(async () => {
    prevHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'cache-home-'));
    srcRoot = mkdtempSync(join(tmpdir(), 'cache-src-'));
    process.env.CODEMIE_HOME = home;
    cache = await import('../core/plugin-cache.js');
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(srcRoot, { recursive: true, force: true });
  });

  it('getPluginCacheDir resolves under CODEMIE_HOME', () => {
    expect(cache.getPluginCacheDir()).toBe(join(home, 'plugins', 'cache'));
  });

  it('installs a plugin into the cache, copying payload files', async () => {
    const src = makeSource('src1', { name: 'alpha', version: '1.0.0' });
    const dest = await cache.installPluginToCache(src);
    expect(dest).toBe(join(cache.getPluginCacheDir(), 'alpha'));
    expect(existsSync(join(dest, 'payload.txt'))).toBe(true);
    expect(cache.isPluginCached('alpha')).toBe(true);
    expect(cache.isPluginCached('beta')).toBe(false);
  });

  it('skips reinstall when the same version is already cached', async () => {
    const src = makeSource('src1', { name: 'alpha', version: '1.0.0' });
    const first = await cache.installPluginToCache(src);
    const second = await cache.installPluginToCache(src);
    expect(second).toBe(first);
  });

  it('replaces the cached copy when the version changes', async () => {
    const v1 = makeSource('src-v1', { name: 'alpha', version: '1.0.0' });
    await cache.installPluginToCache(v1);
    const v2 = join(srcRoot, 'src-v2');
    mkdirSync(join(v2, '.claude-plugin'), { recursive: true });
    writeFileSync(join(v2, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'alpha', version: '2.0.0' }));
    writeFileSync(join(v2, 'newfile.txt'), 'x');
    await cache.installPluginToCache(v2);
    const dest = join(cache.getPluginCacheDir(), 'alpha');
    // Old payload gone, new payload present.
    expect(existsSync(join(dest, 'payload.txt'))).toBe(false);
    expect(existsSync(join(dest, 'newfile.txt'))).toBe(true);
    const names = (await cache.listCachedPlugins()).map(p => p.name);
    expect(names).toEqual(['alpha']);
  });

  it('throws when the source directory does not exist', async () => {
    await expect(cache.installPluginToCache(join(srcRoot, 'nope'))).rejects.toThrow(
      /source directory does not exist/,
    );
  });

  it('lists cached plugins with name and dir', async () => {
    await cache.installPluginToCache(makeSource('s', { name: 'alpha', version: '1.0.0' }));
    const list = await cache.listCachedPlugins();
    expect(list).toEqual([{ name: 'alpha', dir: join(cache.getPluginCacheDir(), 'alpha') }]);
  });

  it('returns [] from listCachedPlugins when the cache dir is missing', async () => {
    expect(await cache.listCachedPlugins()).toEqual([]);
  });

  it('removes a cached plugin and reports found/not-found', async () => {
    await cache.installPluginToCache(makeSource('s', { name: 'alpha', version: '1.0.0' }));
    expect(await cache.removePluginFromCache('alpha')).toBe(true);
    expect(await cache.removePluginFromCache('alpha')).toBe(false);
    expect(cache.isPluginCached('alpha')).toBe(false);
  });

  it('rejects unsafe plugin names on cache operations', () => {
    for (const bad of ['../evil', 'Bad_Name', 'a/b', '', 'has..dots']) {
      expect(() => cache.isPluginCached(bad)).toThrow(/Invalid plugin name/);
    }
  });

  it('reads {} when no settings file exists', async () => {
    expect(await cache.readPluginSettings()).toEqual({});
  });

  it('disable adds to disabled list and is idempotent', async () => {
    await cache.disablePlugin('foo');
    expect(await cache.readPluginSettings()).toEqual({ disabled: ['foo'] });
    await cache.disablePlugin('foo');
    expect(await cache.readPluginSettings()).toEqual({ disabled: ['foo'] });
  });

  it('enable removes from the disabled list', async () => {
    await cache.disablePlugin('foo');
    await cache.enablePlugin('foo');
    expect(await cache.readPluginSettings()).toEqual({ disabled: [] });
  });

  it('write/read settings round-trips', async () => {
    const settings = { enabled: ['x'], disabled: ['y'], dirs: ['/d'] };
    await cache.writePluginSettings(settings);
    expect(await cache.readPluginSettings()).toEqual(settings);
  });

  it('validates plugin names on enable/disable', async () => {
    await expect(cache.disablePlugin('../evil')).rejects.toThrow(/Invalid plugin name/);
    await expect(cache.enablePlugin('Bad_Name')).rejects.toThrow(/Invalid plugin name/);
  });
});
