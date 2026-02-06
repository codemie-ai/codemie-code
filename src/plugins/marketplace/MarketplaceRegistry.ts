import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { existsSync } from 'fs';
import { getCodemiePath } from '../../utils/paths.js';
import { MarketplaceConfigSchema } from './types.js';
import type { MarketplaceSource, MarketplaceConfig } from './types.js';

/**
 * Config file path within CodeMie home
 */
const CONFIG_FILE = 'marketplaces.json';

/**
 * Default marketplace: Anthropic's official Claude plugins
 */
const DEFAULT_MARKETPLACE: MarketplaceSource = {
  id: 'claude-plugins-official',
  name: 'Claude Plugins (Official)',
  type: 'github',
  repository: 'anthropics/claude-plugins-official',
  branch: 'main',
  isDefault: true,
  enabled: true,
};

/**
 * Marketplace registry
 *
 * Manages marketplace sources configuration.
 * Provides built-in default marketplace and user-configured sources.
 */
export class MarketplaceRegistry {
  private static instance: MarketplaceRegistry;
  private sources: MarketplaceSource[] = [];
  private loaded = false;

  /**
   * Private constructor (singleton pattern)
   */
  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): MarketplaceRegistry {
    if (!MarketplaceRegistry.instance) {
      MarketplaceRegistry.instance = new MarketplaceRegistry();
    }
    return MarketplaceRegistry.instance;
  }

  /**
   * Load marketplace configuration
   */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    // Start with default marketplace
    this.sources = [DEFAULT_MARKETPLACE];

    // Load user configuration
    try {
      const config = await this.loadConfig();
      if (config) {
        // Merge user sources (don't duplicate default)
        for (const source of config.sources) {
          if (source.id !== DEFAULT_MARKETPLACE.id) {
            this.sources.push(source);
          }
        }
      }
    } catch {
      // Use default only
    }

    this.loaded = true;
  }

  /**
   * Get all marketplace sources
   */
  async getSources(): Promise<MarketplaceSource[]> {
    await this.load();
    return [...this.sources];
  }

  /**
   * Get enabled marketplace sources
   */
  async getEnabledSources(): Promise<MarketplaceSource[]> {
    await this.load();
    return this.sources.filter((s) => s.enabled);
  }

  /**
   * Get default marketplace source
   */
  async getDefaultSource(): Promise<MarketplaceSource> {
    await this.load();
    return this.sources.find((s) => s.isDefault) || DEFAULT_MARKETPLACE;
  }

  /**
   * Get marketplace source by ID
   */
  async getSource(id: string): Promise<MarketplaceSource | undefined> {
    await this.load();
    return this.sources.find((s) => s.id === id);
  }

  /**
   * Add a new marketplace source
   */
  async addSource(source: Omit<MarketplaceSource, 'isDefault'>): Promise<void> {
    await this.load();

    // Check for duplicates
    if (this.sources.some((s) => s.id === source.id)) {
      throw new Error(`Marketplace source with ID '${source.id}' already exists`);
    }

    // Validate repository format
    if (!source.repository.includes('/')) {
      throw new Error('Repository must be in format owner/repo');
    }

    // Add the source
    this.sources.push({
      ...source,
      isDefault: false,
    });

    // Save configuration
    await this.saveConfig();
  }

  /**
   * Remove a marketplace source
   */
  async removeSource(id: string): Promise<void> {
    await this.load();

    // Cannot remove default
    const source = this.sources.find((s) => s.id === id);
    if (!source) {
      throw new Error(`Marketplace source '${id}' not found`);
    }

    if (source.isDefault) {
      throw new Error('Cannot remove the default marketplace source');
    }

    // Remove the source
    this.sources = this.sources.filter((s) => s.id !== id);

    // Save configuration
    await this.saveConfig();
  }

  /**
   * Enable/disable a marketplace source
   */
  async setSourceEnabled(id: string, enabled: boolean): Promise<void> {
    await this.load();

    const source = this.sources.find((s) => s.id === id);
    if (!source) {
      throw new Error(`Marketplace source '${id}' not found`);
    }

    source.enabled = enabled;

    // Save configuration
    await this.saveConfig();
  }

  /**
   * Update a marketplace source
   */
  async updateSource(
    id: string,
    updates: Partial<Omit<MarketplaceSource, 'id' | 'isDefault'>>
  ): Promise<void> {
    await this.load();

    const index = this.sources.findIndex((s) => s.id === id);
    if (index === -1) {
      throw new Error(`Marketplace source '${id}' not found`);
    }

    // Apply updates
    this.sources[index] = {
      ...this.sources[index],
      ...updates,
    };

    // Save configuration
    await this.saveConfig();
  }

  /**
   * Load configuration from file
   */
  private async loadConfig(): Promise<MarketplaceConfig | null> {
    const configPath = this.getConfigPath();

    if (!existsSync(configPath)) {
      return null;
    }

    try {
      const content = await readFile(configPath, 'utf-8');
      const data = JSON.parse(content);

      const result = MarketplaceConfigSchema.safeParse(data);
      if (!result.success) {
        return null;
      }

      return result.data;
    } catch {
      return null;
    }
  }

  /**
   * Save configuration to file
   */
  private async saveConfig(): Promise<void> {
    const configPath = this.getConfigPath();

    // Filter out default marketplace (it's always available)
    const userSources = this.sources.filter((s) => !s.isDefault);

    const config: MarketplaceConfig = {
      version: 1,
      sources: userSources,
      lastUpdated: new Date().toISOString(),
    };

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  /**
   * Get configuration file path
   */
  private getConfigPath(): string {
    return getCodemiePath(CONFIG_FILE);
  }

  /**
   * Reload configuration from file
   */
  async reload(): Promise<void> {
    this.loaded = false;
    await this.load();
  }

  /**
   * Get marketplace source IDs
   */
  async getSourceIds(): Promise<string[]> {
    await this.load();
    return this.sources.map((s) => s.id);
  }

  /**
   * Check if a source exists
   */
  async hasSource(id: string): Promise<boolean> {
    await this.load();
    return this.sources.some((s) => s.id === id);
  }

  /**
   * Reset singleton instance (for testing)
   */
  static resetInstance(): void {
    if (MarketplaceRegistry.instance) {
      MarketplaceRegistry.instance.sources = [];
      MarketplaceRegistry.instance.loaded = false;
    }
    MarketplaceRegistry.instance = undefined as unknown as MarketplaceRegistry;
  }
}
