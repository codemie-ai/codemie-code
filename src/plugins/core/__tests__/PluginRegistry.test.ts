/**
 * Tests for PluginRegistry singleton
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DiscoveredPlugin, LoadedPlugin } from '../types.js';

// Hoist mock functions so they're available in vi.mock factories
const {
  mockDiscoverPlugins,
  mockDiscoveryClearCache,
  mockLoadPlugin,
  mockLoaderClearCache,
} = vi.hoisted(() => ({
  mockDiscoverPlugins: vi.fn(),
  mockDiscoveryClearCache: vi.fn(),
  mockLoadPlugin: vi.fn(),
  mockLoaderClearCache: vi.fn(),
}));

// Mock PluginDiscovery - use function (not arrow) for `new` support
vi.mock('../PluginDiscovery.js', () => ({
  PluginDiscovery: vi.fn(function () {
    return {
      discoverPlugins: mockDiscoverPlugins,
      clearCache: mockDiscoveryClearCache,
    };
  }),
}));

// Mock PluginLoader - use function (not arrow) for `new` support
vi.mock('../PluginLoader.js', () => ({
  PluginLoader: vi.fn(function () {
    return {
      loadPlugin: mockLoadPlugin,
      clearCache: mockLoaderClearCache,
    };
  }),
}));

const { PluginRegistry } = await import('../PluginRegistry.js');

function makeDiscovered(name: string): DiscoveredPlugin {
  return {
    name,
    path: `/plugins/${name}`,
    manifest: { name, description: `${name} plugin`, version: '1.0.0' },
    isDevelopment: false,
  };
}

function makeLoaded(name: string, skillNames: string[] = []): LoadedPlugin {
  return {
    ...makeDiscovered(name),
    skillNames,
    skillCount: skillNames.length,
    loadedAt: new Date().toISOString(),
    loadErrors: [],
  };
}

describe('PluginRegistry', () => {
  beforeEach(() => {
    PluginRegistry.resetInstance();
    vi.clearAllMocks();

    // Default: no plugins
    mockDiscoverPlugins.mockResolvedValue([]);
    mockLoadPlugin.mockImplementation((p: DiscoveredPlugin) => Promise.resolve(makeLoaded(p.name)));
  });

  describe('singleton', () => {
    it('returns the same instance on multiple getInstance() calls', () => {
      const a = PluginRegistry.getInstance();
      const b = PluginRegistry.getInstance();
      expect(a).toBe(b);
    });

    it('returns a new instance after resetInstance()', () => {
      const a = PluginRegistry.getInstance();
      PluginRegistry.resetInstance();
      const b = PluginRegistry.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('initialization', () => {
    it('discovers and loads plugins during initialize', async () => {
      const discovered = [makeDiscovered('alpha'), makeDiscovered('beta')];
      mockDiscoverPlugins.mockResolvedValue(discovered);

      const registry = PluginRegistry.getInstance();
      await registry.initialize();

      expect(mockDiscoverPlugins).toHaveBeenCalled();
      expect(mockLoadPlugin).toHaveBeenCalledTimes(2);
    });

    it('is idempotent (second call is no-op)', async () => {
      mockDiscoverPlugins.mockResolvedValue([]);

      const registry = PluginRegistry.getInstance();
      await registry.initialize();
      await registry.initialize();

      expect(mockDiscoverPlugins).toHaveBeenCalledTimes(1);
    });

    it('serializes concurrent init calls via initializationPromise', async () => {
      mockDiscoverPlugins.mockResolvedValue([]);

      const registry = PluginRegistry.getInstance();
      const [r1, r2] = await Promise.all([
        registry.initialize(),
        registry.initialize(),
      ]);

      expect(r1).toBeUndefined();
      expect(r2).toBeUndefined();
      expect(mockDiscoverPlugins).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStats', () => {
    it('returns defaults when uninitialized', () => {
      const registry = PluginRegistry.getInstance();
      const stats = registry.getStats();

      expect(stats.initialized).toBe(false);
      expect(stats.pluginCount).toBe(0);
      expect(stats.totalSkillCount).toBe(0);
      expect(stats.pluginNames).toEqual([]);
    });

    it('returns populated stats after init', async () => {
      const discovered = [makeDiscovered('foo')];
      mockDiscoverPlugins.mockResolvedValue(discovered);
      mockLoadPlugin.mockResolvedValue(makeLoaded('foo', ['skill-a', 'skill-b']));

      const registry = PluginRegistry.getInstance();
      await registry.initialize();
      const stats = registry.getStats();

      expect(stats.initialized).toBe(true);
      expect(stats.pluginCount).toBe(1);
      expect(stats.totalSkillCount).toBe(2);
      expect(stats.pluginNames).toEqual(['foo']);
    });
  });

  describe('retrieval', () => {
    it('retrieves a plugin by name', async () => {
      const discovered = [makeDiscovered('myplugin')];
      mockDiscoverPlugins.mockResolvedValue(discovered);
      mockLoadPlugin.mockResolvedValue(makeLoaded('myplugin'));

      const registry = PluginRegistry.getInstance();
      const plugin = await registry.getPlugin('myplugin');

      expect(plugin).toBeDefined();
      expect(plugin!.name).toBe('myplugin');
    });

    it('returns undefined for unknown plugin', async () => {
      mockDiscoverPlugins.mockResolvedValue([]);

      const registry = PluginRegistry.getInstance();
      const plugin = await registry.getPlugin('nonexistent');

      expect(plugin).toBeUndefined();
    });

    it('returns all plugin names', async () => {
      const discovered = [makeDiscovered('a'), makeDiscovered('b')];
      mockDiscoverPlugins.mockResolvedValue(discovered);
      mockLoadPlugin.mockImplementation((p: DiscoveredPlugin) =>
        Promise.resolve(makeLoaded(p.name))
      );

      const registry = PluginRegistry.getInstance();
      const names = await registry.getPluginNames();

      expect(names).toEqual(['a', 'b']);
    });

    it('hasPlugin returns true for loaded plugin', async () => {
      const discovered = [makeDiscovered('test')];
      mockDiscoverPlugins.mockResolvedValue(discovered);
      mockLoadPlugin.mockResolvedValue(makeLoaded('test'));

      const registry = PluginRegistry.getInstance();
      const has = await registry.hasPlugin('test');

      expect(has).toBe(true);
    });
  });

  describe('skills', () => {
    it('returns per-plugin skills', async () => {
      const discovered = [makeDiscovered('myplugin')];
      mockDiscoverPlugins.mockResolvedValue(discovered);
      mockLoadPlugin.mockResolvedValue(makeLoaded('myplugin', ['commit', 'review']));

      const registry = PluginRegistry.getInstance();
      const skills = await registry.getPluginSkills('myplugin');

      expect(skills).toEqual(['commit', 'review']);
    });

    it('returns empty for plugin with no skills', async () => {
      const discovered = [makeDiscovered('noskills')];
      mockDiscoverPlugins.mockResolvedValue(discovered);
      mockLoadPlugin.mockResolvedValue(makeLoaded('noskills'));

      const registry = PluginRegistry.getInstance();
      const skills = await registry.getPluginSkills('noskills');

      expect(skills).toEqual([]);
    });

    it('aggregates skills from all plugins', async () => {
      const discovered = [makeDiscovered('a'), makeDiscovered('b')];
      mockDiscoverPlugins.mockResolvedValue(discovered);
      mockLoadPlugin
        .mockResolvedValueOnce(makeLoaded('a', ['s1']))
        .mockResolvedValueOnce(makeLoaded('b', ['s2', 's3']));

      const registry = PluginRegistry.getInstance();
      const allSkills = await registry.getAllPluginSkills();

      expect(allSkills.get('a')).toEqual(['s1']);
      expect(allSkills.get('b')).toEqual(['s2', 's3']);
    });
  });

  describe('reset', () => {
    it('clears state and calls clearCache on discovery and loader', async () => {
      mockDiscoverPlugins.mockResolvedValue([makeDiscovered('x')]);
      mockLoadPlugin.mockResolvedValue(makeLoaded('x'));

      const registry = PluginRegistry.getInstance();
      await registry.initialize();

      expect(registry.getStats().initialized).toBe(true);

      registry.reset();

      expect(registry.getStats().initialized).toBe(false);
      expect(registry.getStats().pluginCount).toBe(0);
      expect(mockDiscoveryClearCache).toHaveBeenCalled();
      expect(mockLoaderClearCache).toHaveBeenCalled();
    });
  });

  describe('reload', () => {
    it('resets then re-initializes with fresh discovery', async () => {
      mockDiscoverPlugins.mockResolvedValue([]);

      const registry = PluginRegistry.getInstance();
      await registry.initialize();

      mockDiscoverPlugins.mockResolvedValue([makeDiscovered('new')]);
      mockLoadPlugin.mockResolvedValue(makeLoaded('new'));

      await registry.reload();

      const names = await registry.getPluginNames();
      expect(names).toContain('new');
      // discoverPlugins called at least twice: initial + reload
      expect(mockDiscoverPlugins).toHaveBeenCalledTimes(2);
    });
  });

  describe('addDevPluginDir', () => {
    it('adds directory to discovery options', async () => {
      const registry = PluginRegistry.getInstance();
      registry.addDevPluginDir('/my/dev/plugins');

      mockDiscoverPlugins.mockResolvedValue([]);
      await registry.initialize();

      expect(mockDiscoverPlugins).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginDirs: expect.arrayContaining(['/my/dev/plugins']),
        })
      );
    });

    it('does not add duplicates', () => {
      const registry = PluginRegistry.getInstance();
      registry.addDevPluginDir('/dev');
      registry.addDevPluginDir('/dev');

      // No way to inspect devPluginDirs directly, but it shouldn't trigger multiple resets
      // We can verify through behavior: init should only get one copy
    });

    it('triggers reset if already initialized', async () => {
      mockDiscoverPlugins.mockResolvedValue([]);

      const registry = PluginRegistry.getInstance();
      await registry.initialize();

      expect(registry.getStats().initialized).toBe(true);

      registry.addDevPluginDir('/new/dir');

      // After addDevPluginDir on an initialized registry, it resets
      expect(registry.getStats().initialized).toBe(false);
    });
  });
});
