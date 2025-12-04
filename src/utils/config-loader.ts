import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import dotenv from 'dotenv';
import chalk from 'chalk';
import {
  CodeMieConfigOptions,
  ProviderProfile,
  MultiProviderConfig,
  CodeMieIntegrationInfo,
  ConfigWithSource,
  isMultiProviderConfig,
  isLegacyConfig
} from '../env/types.js';
import { ProviderRegistry } from '../providers/index.js';

// Re-export for backward compatibility
export type { CodeMieConfigOptions, CodeMieIntegrationInfo, ConfigWithSource };

/**
 * Unified configuration loader with priority system:
 * CLI args > Env vars > Project config > Global config > Defaults
 *
 * Supports both:
 * - Legacy single-provider config (version 1)
 * - Multi-provider profiles (version 2)
 */
export class ConfigLoader {
  private static GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.codemie');
  private static GLOBAL_CONFIG = path.join(ConfigLoader.GLOBAL_CONFIG_DIR, 'config.json');
  private static LOCAL_CONFIG = '.codemie/config.json';

  // Cache for multi-provider config
  private static multiProviderCache: MultiProviderConfig | null = null;

  /**
   * Load configuration with proper priority:
   * CLI args > Env vars > Project config > Global config > Defaults
   */
  static async load(
    workingDir: string = process.cwd(),
    cliOverrides?: Partial<CodeMieConfigOptions>
  ): Promise<CodeMieConfigOptions> {
    // 5. Built-in defaults (lowest priority)
    const config: CodeMieConfigOptions = {
      name: 'default',
      provider: 'openai',
      timeout: 300,
      debug: false,
      allowedDirs: [],
      ignorePatterns: ['node_modules', '.git', 'dist', 'build']
    };

    // 4. Global config (~/.codemie/config.json)
    // Load from active profile if multi-provider, otherwise load as-is
    const globalConfig = await this.loadGlobalConfigProfile(cliOverrides?.name);
    Object.assign(config, this.removeUndefined(globalConfig));

    // 3. Project-local config (.codemie/config.json)
    const localConfigPath = path.join(workingDir, this.LOCAL_CONFIG);
    const localConfig = await this.loadJsonConfig(localConfigPath);
    Object.assign(config, this.removeUndefined(localConfig));

    // 2. Environment variables (load .env first if in project)
    const envPath = path.join(workingDir, '.env');
    try {
      await fs.access(envPath);
      dotenv.config({ path: envPath });
    } catch {
      // No .env file, that's fine
    }
    const envConfig = this.loadFromEnv();
    Object.assign(config, this.removeUndefined(envConfig));

    // 1. CLI arguments (highest priority)
    if (cliOverrides) {
      Object.assign(config, this.removeUndefined(cliOverrides));
    }

    return config;
  }

  /**
   * Load full configuration including analytics
   * Returns the complete multi-provider config with analytics settings
   */
  static async loadFull(
    workingDir: string = process.cwd(),
    cliOverrides?: { name?: string }
  ): Promise<MultiProviderConfig> {
    const rawConfig = await this.loadJsonConfig(this.GLOBAL_CONFIG);

    if (isMultiProviderConfig(rawConfig)) {
      return rawConfig;
    }

    // Return default multi-provider structure if legacy
    return {
      version: 2,
      activeProfile: 'default',
      profiles: {
        default: await this.load(workingDir, cliOverrides)
      }
    };
  }

  /**
   * Load global config and extract active profile if multi-provider
   */
  private static async loadGlobalConfigProfile(profileName?: string): Promise<Partial<CodeMieConfigOptions>> {
    const rawConfig = await this.loadJsonConfig(this.GLOBAL_CONFIG);

    // Check if multi-provider config
    if (isMultiProviderConfig(rawConfig)) {
      this.multiProviderCache = rawConfig;
      const profile = profileName || rawConfig.activeProfile;

      // Validate that active profile exists
      if (!profile) {
        throw new Error('No active profile set. Run: codemie setup');
      }

      if (!rawConfig.profiles[profile]) {
        const availableProfiles = Object.keys(rawConfig.profiles);
        if (availableProfiles.length === 0) {
          throw new Error('No profiles configured. Run: codemie setup');
        }
        throw new Error(
          `Profile "${profile}" not found. Available profiles: ${availableProfiles.join(', ')}`
        );
      }

      // Return profile with name included
      return { ...rawConfig.profiles[profile], name: profile };
    }

    // Legacy single-provider config
    if (isLegacyConfig(rawConfig)) {
      return { ...rawConfig, name: 'default' };
    }

    return {};
  }

  /**
   * Load configuration with validation (throws if required fields missing)
   */
  static async loadAndValidate(
    workingDir: string = process.cwd(),
    cliOverrides?: Partial<CodeMieConfigOptions>
  ): Promise<CodeMieConfigOptions> {
    const config = await this.load(workingDir, cliOverrides);
    this.validate(config);
    return config;
  }

  /**
   * Load configuration from environment variables
   */
  private static loadFromEnv(): Partial<CodeMieConfigOptions> {
    const env: Partial<CodeMieConfigOptions> = {};

    if (process.env.CODEMIE_PROVIDER) {
      env.provider = process.env.CODEMIE_PROVIDER;
    }
    if (process.env.CODEMIE_BASE_URL) {
      env.baseUrl = process.env.CODEMIE_BASE_URL;
    }
    if (process.env.CODEMIE_API_KEY) {
      env.apiKey = process.env.CODEMIE_API_KEY;
    }
    if (process.env.CODEMIE_MODEL) {
      env.model = process.env.CODEMIE_MODEL;
    }
    if (process.env.CODEMIE_TIMEOUT) {
      env.timeout = parseInt(process.env.CODEMIE_TIMEOUT, 10);
    }
    if (process.env.CODEMIE_DEBUG) {
      env.debug = process.env.CODEMIE_DEBUG === 'true';
    }
    if (process.env.CODEMIE_ALLOWED_DIRS) {
      env.allowedDirs = process.env.CODEMIE_ALLOWED_DIRS.split(',').map(s => s.trim());
    }
    if (process.env.CODEMIE_IGNORE_PATTERNS) {
      env.ignorePatterns = process.env.CODEMIE_IGNORE_PATTERNS.split(',').map(s => s.trim());
    }

    // SSO-specific environment variables
    if (process.env.CODEMIE_URL) env.codeMieUrl = process.env.CODEMIE_URL;
    if (process.env.CODEMIE_AUTH_METHOD) env.authMethod = process.env.CODEMIE_AUTH_METHOD as 'manual' | 'sso';
    // Handle CodeMie integration from environment variables
    if (process.env.CODEMIE_INTEGRATION_ID || process.env.CODEMIE_INTEGRATION_ALIAS) {
      env.codeMieIntegration = {
        id: process.env.CODEMIE_INTEGRATION_ID || '',
        alias: process.env.CODEMIE_INTEGRATION_ALIAS || ''
      };
    }

    return env;
  }

  /**
   * Load JSON config file
   */
  private static async loadJsonConfig(filePath: string): Promise<Partial<CodeMieConfigOptions>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  /**
   * Save configuration to global config file
   * Supports both legacy and multi-provider formats
   */
  static async saveGlobalConfig(config: Partial<CodeMieConfigOptions>): Promise<void> {
    await fs.mkdir(this.GLOBAL_CONFIG_DIR, { recursive: true });
    await fs.writeFile(
      this.GLOBAL_CONFIG,
      JSON.stringify(config, null, 2),
      'utf-8'
    );
    // Clear cache
    this.multiProviderCache = null;
  }

  /**
   * Load multi-provider config (migrates from legacy if needed)
   */
  static async loadMultiProviderConfig(): Promise<MultiProviderConfig> {
    const rawConfig = await this.loadJsonConfig(this.GLOBAL_CONFIG);

    // Already multi-provider format
    if (isMultiProviderConfig(rawConfig)) {
      return rawConfig;
    }

    // Legacy format - migrate to multi-provider
    if (isLegacyConfig(rawConfig)) {
      const defaultProfile: ProviderProfile = {
        name: 'default',
        ...rawConfig
      };

      return {
        version: 2,
        activeProfile: 'default',
        profiles: {
          default: defaultProfile
        }
      };
    }

    // Empty config - return empty multi-provider structure
    return {
      version: 2,
      activeProfile: 'default',
      profiles: {}
    };
  }

  /**
   * Save multi-provider config
   */
  static async saveMultiProviderConfig(config: MultiProviderConfig): Promise<void> {
    await this.saveGlobalConfig(config as any);
  }

  /**
   * Add or update a profile
   */
  static async saveProfile(profileName: string, profile: ProviderProfile): Promise<void> {
    const config = await this.loadMultiProviderConfig();

    // Set profile name
    profile.name = profileName;

    // Add or update profile
    config.profiles[profileName] = profile;

    // If this is the first profile, make it active
    if (Object.keys(config.profiles).length === 1) {
      config.activeProfile = profileName;
    }

    await this.saveMultiProviderConfig(config);
  }

  /**
   * Delete a profile
   */
  static async deleteProfile(profileName: string): Promise<void> {
    const config = await this.loadMultiProviderConfig();

    if (!config.profiles[profileName]) {
      throw new Error(`Profile "${profileName}" not found`);
    }

    delete config.profiles[profileName];

    // If we deleted the active profile, switch to another one (if any exist)
    if (config.activeProfile === profileName) {
      const remainingProfiles = Object.keys(config.profiles);
      config.activeProfile = remainingProfiles.length > 0 ? remainingProfiles[0] : '';
    }

    await this.saveMultiProviderConfig(config);
  }

  /**
   * Switch active profile
   */
  static async switchProfile(profileName: string): Promise<void> {
    const config = await this.loadMultiProviderConfig();

    if (!config.profiles[profileName]) {
      throw new Error(
        `Profile "${profileName}" not found. Available profiles: ${Object.keys(config.profiles).join(', ')}`
      );
    }

    config.activeProfile = profileName;
    await this.saveMultiProviderConfig(config);
  }

  /**
   * List all profiles
   */
  static async listProfiles(): Promise<{ name: string; active: boolean; profile: ProviderProfile }[]> {
    const config = await this.loadMultiProviderConfig();

    return Object.entries(config.profiles).map(([name, profile]) => ({
      name,
      active: name === config.activeProfile,
      profile
    }));
  }

  /**
   * Get a specific profile
   */
  static async getProfile(profileName: string): Promise<ProviderProfile | null> {
    const config = await this.loadMultiProviderConfig();
    return config.profiles[profileName] || null;
  }

  /**
   * Rename a profile
   */
  static async renameProfile(oldName: string, newName: string): Promise<void> {
    const config = await this.loadMultiProviderConfig();

    if (!config.profiles[oldName]) {
      throw new Error(`Profile "${oldName}" not found`);
    }

    if (config.profiles[newName]) {
      throw new Error(`Profile "${newName}" already exists`);
    }

    // Copy profile with new name
    const profile = { ...config.profiles[oldName], name: newName };
    config.profiles[newName] = profile;
    delete config.profiles[oldName];

    // Update active profile if needed
    if (config.activeProfile === oldName) {
      config.activeProfile = newName;
    }

    await this.saveMultiProviderConfig(config);
  }

  /**
   * Get active profile name
   */
  static async getActiveProfileName(): Promise<string | null> {
    const config = await this.loadMultiProviderConfig();
    return config.activeProfile || null;
  }

  /**
   * Save configuration to project config file
   */
  static async saveProjectConfig(
    workingDir: string,
    config: Partial<CodeMieConfigOptions>
  ): Promise<void> {
    const configDir = path.join(workingDir, '.codemie');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8'
    );
  }

  /**
   * Delete global config file
   */
  static async deleteGlobalConfig(): Promise<void> {
    try {
      await fs.unlink(this.GLOBAL_CONFIG);
    } catch (error: any) {
      // Ignore if file doesn't exist
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Delete project config file
   */
  static async deleteProjectConfig(workingDir: string): Promise<void> {
    try {
      const localConfigPath = path.join(workingDir, this.LOCAL_CONFIG);
      await fs.unlink(localConfigPath);
    } catch (error: any) {
      // Ignore if file doesn't exist
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Check if global config exists and is not empty
   */
  static async hasGlobalConfig(): Promise<boolean> {
    try {
      await fs.access(this.GLOBAL_CONFIG);
      const config = await this.loadJsonConfig(this.GLOBAL_CONFIG);
      // Check if config has any actual values (not just an empty object)
      return Object.keys(config).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Check if project config exists
   */
  static async hasProjectConfig(workingDir: string = process.cwd()): Promise<boolean> {
    try {
      const localConfigPath = path.join(workingDir, this.LOCAL_CONFIG);
      await fs.access(localConfigPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove undefined values from object
   */
  private static removeUndefined(obj: any): any {
    return Object.fromEntries(
      Object.entries(obj).filter(([_, v]) => v !== undefined)
    );
  }

  /**
   * Validate required configuration
   */
  private static validate(config: CodeMieConfigOptions): void {
    if (!config.baseUrl) {
      throw new Error(
        'CODEMIE_BASE_URL is required. Run: codemie setup'
      );
    }
    if (!config.apiKey) {
      throw new Error(
        'CODEMIE_API_KEY is required. Run: codemie setup'
      );
    }
    if (!config.model) {
      throw new Error(
        'CODEMIE_MODEL is required. Run: codemie setup'
      );
    }
  }

  /**
   * Load configuration with source tracking
   */
  static async loadWithSources(
    workingDir: string = process.cwd()
  ): Promise<Record<string, ConfigWithSource>> {
    const sources: Record<string, ConfigWithSource> = {};

    // Load all config layers
    const configs = [
      {
        data: {
          timeout: 300,
          debug: false
        },
        source: 'default' as const
      },
      {
        data: await this.loadJsonConfig(this.GLOBAL_CONFIG),
        source: 'global' as const
      },
      {
        data: await this.loadJsonConfig(path.join(workingDir, this.LOCAL_CONFIG)),
        source: 'project' as const
      },
      {
        data: this.loadFromEnv(),
        source: 'env' as const
      }
    ];

    // Track where each value comes from (last one wins)
    for (const { data, source } of configs) {
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined && value !== null) {
          sources[key] = { value, source };
        }
      }
    }

    return sources;
  }

  /**
   * Show configuration with source attribution
   */
  static async showWithSources(workingDir: string = process.cwd()): Promise<void> {
    const sources = await this.loadWithSources(workingDir);

    console.log(chalk.bold('\nConfiguration Sources:\n'));

    const sortedKeys = Object.keys(sources).sort();
    for (const key of sortedKeys) {
      const { value, source } = sources[key];
      const displayValue = this.maskSensitive(key, value);
      const sourceColor = this.getSourceColor(source);
      const sourceLabel = sourceColor(`(${source})`);
      console.log(`  ${chalk.cyan(key)}: ${displayValue} ${sourceLabel}`);
    }

    console.log(chalk.white('\nPriority: cli > env > project > global > default\n'));
  }

  /**
   * Mask sensitive values
   */
  private static maskSensitive(key: string, value: any): string {
    const keyLower = key.toLowerCase();

    // Handle sensitive values
    if (keyLower.includes('key') || keyLower.includes('token') || keyLower.includes('password')) {
      const valueStr = String(value);
      if (valueStr.length <= 8) {
        return '***';
      }
      const start = valueStr.substring(0, 8);
      const end = valueStr.substring(valueStr.length - 4);
      return `${start}***${end}`;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.join(', ');
    }

    // Handle objects (like analytics, profiles)
    if (typeof value === 'object' && value !== null) {
      // Recursively mask sensitive values in nested objects
      const masked = this.maskNestedSensitive(value);
      return JSON.stringify(masked, null, 2);
    }

    return String(value);
  }

  /**
   * Recursively mask sensitive values in nested objects
   */
  private static maskNestedSensitive(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map(item => this.maskNestedSensitive(item));
    }

    if (typeof obj === 'object' && obj !== null) {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        const keyLower = key.toLowerCase();
        if (keyLower.includes('key') || keyLower.includes('token') || keyLower.includes('password')) {
          const valueStr = String(value);
          if (valueStr.length <= 8) {
            result[key] = '***';
          } else {
            const start = valueStr.substring(0, 8);
            const end = valueStr.substring(valueStr.length - 4);
            result[key] = `${start}***${end}`;
          }
        } else if (typeof value === 'object' && value !== null) {
          result[key] = this.maskNestedSensitive(value);
        } else {
          result[key] = value;
        }
      }
      return result;
    }

    return obj;
  }

  /**
   * Get color for source
   */
  private static getSourceColor(source: string): (text: string) => string {
    const colors: Record<string, (text: string) => string> = {
      default: chalk.white,
      global: chalk.cyan,
      project: chalk.yellow,
      env: chalk.green,
      cli: chalk.magenta
    };
    return colors[source] || chalk.white;
  }

  /**
   * Get environment variable overrides
   */
  static getEnvOverrides(): Partial<CodeMieConfigOptions> {
    return this.removeUndefined(this.loadFromEnv());
  }

  /**
   * Export provider-specific environment variables
   * Uses ProviderRegistry to get env mappings from provider templates
   */
  static exportProviderEnvVars(config: CodeMieConfigOptions): Record<string, string> {
    const env: Record<string, string> = {};

    // Always set generic CODEMIE_* vars
    if (config.provider) env.CODEMIE_PROVIDER = config.provider;
    if (config.baseUrl) env.CODEMIE_BASE_URL = config.baseUrl;
    if (config.apiKey) env.CODEMIE_API_KEY = config.apiKey;
    if (config.model) env.CODEMIE_MODEL = config.model;
    if (config.timeout) env.CODEMIE_TIMEOUT = String(config.timeout);
    if (config.debug) env.CODEMIE_DEBUG = String(config.debug);

    // Get provider template from registry
    const providerName = (config.provider || 'openai').toLowerCase();
    const providerTemplate = ProviderRegistry.getProvider(providerName);

    if (providerTemplate?.envMapping) {
      // Apply env mappings from provider template
      const { envMapping } = providerTemplate;

      // Map base URL
      if (config.baseUrl && envMapping.baseUrl) {
        for (const envVar of envMapping.baseUrl) {
          env[envVar] = config.baseUrl;
        }
      }

      // Map API key
      if (config.apiKey && envMapping.apiKey) {
        for (const envVar of envMapping.apiKey) {
          env[envVar] = config.apiKey;
        }
      }

      // Map model
      if (config.model && envMapping.model) {
        for (const envVar of envMapping.model) {
          env[envVar] = config.model;
        }
      }
    }

    // Special case: SSO-specific environment variables
    if (providerName === 'ai-run-sso') {
      if (config.codeMieUrl) env.CODEMIE_URL = config.codeMieUrl;
      if (config.authMethod) env.CODEMIE_AUTH_METHOD = config.authMethod;
      // Only export integration ID if integration is configured
      if (config.codeMieIntegration?.id) {
        env.CODEMIE_INTEGRATION_ID = config.codeMieIntegration.id;
      }
    }

    return env;
  }
}
