import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { existsSync } from 'fs';
import { getCodemiePath } from '../../utils/paths.js';
import { PluginManifestParser } from '../core/PluginManifestParser.js';
import { MarketplaceIndexSchema, MarketplacePluginEntrySchema } from './types.js';
import type {
  MarketplaceSource,
  MarketplaceIndex,
  MarketplacePluginEntry,
  MarketplaceSearchResult,
  PluginDownloadInfo,
} from './types.js';

/**
 * Cache directory within CodeMie home
 */
const CACHE_DIR = 'cache';

/**
 * Cache TTL in milliseconds (1 hour)
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * GitHub API base URL
 */
const GITHUB_API_URL = 'https://api.github.com';

/**
 * GitHub raw content base URL
 */
const GITHUB_RAW_URL = 'https://raw.githubusercontent.com';

/**
 * Marketplace client
 *
 * Fetches plugin listings from GitHub-based marketplaces.
 * Caches index locally for performance.
 */
export class MarketplaceClient {
  private indexCache: Map<string, MarketplaceIndex> = new Map();

  /**
   * Fetch marketplace index from a source
   *
   * @param source - Marketplace source
   * @param forceRefresh - Force refresh from remote
   * @returns Marketplace index
   */
  async fetchIndex(
    source: MarketplaceSource,
    forceRefresh = false
  ): Promise<MarketplaceIndex> {
    // Check memory cache
    if (!forceRefresh && this.indexCache.has(source.id)) {
      const cached = this.indexCache.get(source.id)!;
      if (new Date(cached.expiresAt) > new Date()) {
        return cached;
      }
    }

    // Check file cache
    if (!forceRefresh) {
      const fileCached = await this.loadCachedIndex(source.id);
      if (fileCached && new Date(fileCached.expiresAt) > new Date()) {
        this.indexCache.set(source.id, fileCached);
        return fileCached;
      }
    }

    // Fetch from remote
    const index = await this.fetchRemoteIndex(source);

    // Save to caches
    this.indexCache.set(source.id, index);
    await this.saveCachedIndex(source.id, index);

    return index;
  }

  /**
   * Fetch index from remote GitHub repository
   */
  private async fetchRemoteIndex(source: MarketplaceSource): Promise<MarketplaceIndex> {
    const branch = source.branch || 'main';
    const plugins: MarketplacePluginEntry[] = [];

    try {
      // Fetch plugins from 'plugins/' directory
      const pluginsDirPlugins = await this.fetchPluginsFromDirectory(
        source.repository,
        branch,
        'plugins'
      );
      plugins.push(...pluginsDirPlugins);

      // Fetch external plugin references from 'external_plugins/' directory
      const externalPlugins = await this.fetchExternalPlugins(
        source.repository,
        branch
      );
      plugins.push(...externalPlugins);
    } catch (error) {
      // If we can't fetch, return empty index
      console.error(
        `Failed to fetch marketplace index from ${source.repository}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);

    return {
      sourceId: source.id,
      plugins,
      version: 1,
      fetchedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Fetch plugins from a directory in the repository
   */
  private async fetchPluginsFromDirectory(
    repository: string,
    branch: string,
    directory: string
  ): Promise<MarketplacePluginEntry[]> {
    const plugins: MarketplacePluginEntry[] = [];

    try {
      // Fetch directory listing via GitHub API
      const [owner, repo] = repository.split('/');
      const apiUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/contents/${directory}?ref=${branch}`;

      const response = await fetch(apiUrl, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'codemie-code',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          // Directory doesn't exist, which is fine
          return plugins;
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const entries = (await response.json()) as Array<{
        name: string;
        type: string;
        path: string;
      }>;

      // Process each plugin directory
      for (const entry of entries) {
        if (entry.type !== 'dir') continue;

        try {
          // Fetch the plugin manifest
          const manifestUrl = `${GITHUB_RAW_URL}/${repository}/${branch}/${entry.path}/.claude-plugin/plugin.json`;
          const manifestResponse = await fetch(manifestUrl);

          if (!manifestResponse.ok) continue;

          const manifestContent = await manifestResponse.text();
          const parseResult = PluginManifestParser.parseContent(
            manifestContent,
            manifestUrl
          );

          if (parseResult.manifest) {
            plugins.push({
              name: parseResult.manifest.name,
              description: parseResult.manifest.description,
              version: parseResult.manifest.version,
              author: parseResult.manifest.author,
              keywords: parseResult.manifest.keywords,
              category: parseResult.manifest.codemie?.category,
              path: entry.path,
              isExternal: false,
            });
          }
        } catch {
          // Skip plugins that fail to load
        }
      }
    } catch (error) {
      // Log but don't throw - allow partial results
      console.error(
        `Failed to fetch plugins from ${directory}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    return plugins;
  }

  /**
   * Fetch external plugin references
   */
  private async fetchExternalPlugins(
    repository: string,
    branch: string
  ): Promise<MarketplacePluginEntry[]> {
    const plugins: MarketplacePluginEntry[] = [];

    try {
      // Fetch external_plugins directory
      const [owner, repo] = repository.split('/');
      const apiUrl = `${GITHUB_API_URL}/repos/${owner}/${repo}/contents/external_plugins?ref=${branch}`;

      const response = await fetch(apiUrl, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'codemie-code',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return plugins;
        }
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const entries = (await response.json()) as Array<{
        name: string;
        type: string;
        path: string;
      }>;

      // Process each external plugin JSON file
      for (const entry of entries) {
        if (entry.type !== 'file' || !entry.name.endsWith('.json')) continue;

        try {
          const jsonUrl = `${GITHUB_RAW_URL}/${repository}/${branch}/${entry.path}`;
          const jsonResponse = await fetch(jsonUrl);

          if (!jsonResponse.ok) continue;

          const content = (await jsonResponse.json()) as Record<string, unknown>;

          // Validate with schema
          const result = MarketplacePluginEntrySchema.safeParse({
            ...content,
            isExternal: true,
            path: entry.path,
          });

          if (result.success) {
            plugins.push(result.data);
          }
        } catch {
          // Skip invalid external plugins
        }
      }
    } catch {
      // Directory doesn't exist or other error
    }

    return plugins;
  }

  /**
   * Load cached index from file
   */
  private async loadCachedIndex(sourceId: string): Promise<MarketplaceIndex | null> {
    const cachePath = this.getCachePath(sourceId);

    try {
      if (!existsSync(cachePath)) {
        return null;
      }

      const content = await readFile(cachePath, 'utf-8');
      const data = JSON.parse(content);

      const result = MarketplaceIndexSchema.safeParse(data);
      if (!result.success) {
        return null;
      }

      return result.data;
    } catch {
      return null;
    }
  }

  /**
   * Save index to file cache
   */
  private async saveCachedIndex(sourceId: string, index: MarketplaceIndex): Promise<void> {
    const cachePath = this.getCachePath(sourceId);

    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(index, null, 2), 'utf-8');
    } catch {
      // Ignore cache write errors
    }
  }

  /**
   * Get cache file path for a source
   */
  private getCachePath(sourceId: string): string {
    const safeId = sourceId.replace(/[^a-zA-Z0-9-_]/g, '_');
    return getCodemiePath(CACHE_DIR, `marketplace-${safeId}.json`);
  }

  /**
   * Search for plugins across all provided sources
   */
  async search(
    query: string,
    sources: MarketplaceSource[]
  ): Promise<MarketplaceSearchResult[]> {
    const results: MarketplaceSearchResult[] = [];
    const queryLower = query.toLowerCase();

    for (const source of sources) {
      if (!source.enabled) continue;

      try {
        const index = await this.fetchIndex(source);

        for (const plugin of index.plugins) {
          const score = this.calculateSearchScore(plugin, queryLower);
          if (score > 0) {
            results.push({
              plugin,
              sourceId: source.id,
              sourceName: source.name,
              score,
            });
          }
        }
      } catch {
        // Skip sources that fail
      }
    }

    // Sort by score (descending)
    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Calculate search relevance score
   */
  private calculateSearchScore(
    plugin: MarketplacePluginEntry,
    query: string
  ): number {
    let score = 0;

    // Exact name match
    if (plugin.name.toLowerCase() === query) {
      score += 100;
    }
    // Name contains query
    else if (plugin.name.toLowerCase().includes(query)) {
      score += 50;
    }

    // Description contains query
    if (plugin.description.toLowerCase().includes(query)) {
      score += 20;
    }

    // Keywords contain query
    if (plugin.keywords?.some((k) => k.toLowerCase().includes(query))) {
      score += 30;
    }

    // Category matches
    if (plugin.category?.toLowerCase().includes(query)) {
      score += 25;
    }

    // Author matches
    if (plugin.author?.toLowerCase().includes(query)) {
      score += 10;
    }

    return score;
  }

  /**
   * Get plugin download info
   */
  async getPluginDownloadInfo(
    source: MarketplaceSource,
    pluginName: string
  ): Promise<PluginDownloadInfo | null> {
    const index = await this.fetchIndex(source);
    const plugin = index.plugins.find((p) => p.name === pluginName);

    if (!plugin) {
      return null;
    }

    const branch = source.branch || 'main';

    // Handle external plugins
    if (plugin.isExternal && plugin.externalRepo) {
      return {
        name: plugin.name,
        downloadUrl: `https://github.com/${plugin.externalRepo}/archive/refs/heads/main.zip`,
        repository: plugin.externalRepo,
        branch: 'main',
        path: '',
        version: plugin.version,
      };
    }

    // Internal plugin - need to download from the marketplace repo

    return {
      name: plugin.name,
      downloadUrl: `https://github.com/${source.repository}/archive/refs/heads/${branch}.zip`,
      repository: source.repository,
      branch,
      path: plugin.path,
      version: plugin.version,
    };
  }

  /**
   * Get plugin by name from a source
   */
  async getPlugin(
    source: MarketplaceSource,
    pluginName: string
  ): Promise<MarketplacePluginEntry | null> {
    const index = await this.fetchIndex(source);
    return index.plugins.find((p) => p.name === pluginName) || null;
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.indexCache.clear();
  }

  /**
   * Get cache directory path
   */
  static getCacheDir(): string {
    return getCodemiePath(CACHE_DIR);
  }
}
