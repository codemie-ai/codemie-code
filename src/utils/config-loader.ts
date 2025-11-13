import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import dotenv from 'dotenv';
import chalk from 'chalk';

/**
 * Configuration options for CodeMie Code
 */
export interface CodeMieConfigOptions {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeout?: number;
  debug?: boolean;
  mcpServers?: string[];
  allowedDirs?: string[];
  ignorePatterns?: string[];
}

/**
 * Configuration with source tracking
 */
export interface ConfigWithSource {
  value: any;
  source: 'default' | 'global' | 'project' | 'env' | 'cli';
}

/**
 * Unified configuration loader with priority system:
 * CLI args > Env vars > Project config > Global config > Defaults
 */
export class ConfigLoader {
  private static GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.codemie');
  private static GLOBAL_CONFIG = path.join(ConfigLoader.GLOBAL_CONFIG_DIR, 'config.json');
  private static LOCAL_CONFIG = '.codemie/config.json';

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
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      timeout: 300,
      debug: false,
      mcpServers: [],
      allowedDirs: [],
      ignorePatterns: ['node_modules', '.git', 'dist', 'build']
    };

    // 4. Global config (~/.codemie/config.json)
    const globalConfig = await this.loadJsonConfig(this.GLOBAL_CONFIG);
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
    if (process.env.CODEMIE_MCP_SERVERS) {
      env.mcpServers = process.env.CODEMIE_MCP_SERVERS.split(',').map(s => s.trim());
    }
    if (process.env.CODEMIE_ALLOWED_DIRS) {
      env.allowedDirs = process.env.CODEMIE_ALLOWED_DIRS.split(',').map(s => s.trim());
    }
    if (process.env.CODEMIE_IGNORE_PATTERNS) {
      env.ignorePatterns = process.env.CODEMIE_IGNORE_PATTERNS.split(',').map(s => s.trim());
    }

    // Check for AWS Bedrock configuration
    if (process.env.CLAUDE_CODE_USE_BEDROCK === '1' && process.env.ANTHROPIC_MODEL) {
      env.provider = 'bedrock';
      env.model = process.env.ANTHROPIC_MODEL;
      env.baseUrl = 'bedrock';
      env.apiKey = 'bedrock'; // Placeholder for AWS credentials
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
   */
  static async saveGlobalConfig(config: Partial<CodeMieConfigOptions>): Promise<void> {
    await fs.mkdir(this.GLOBAL_CONFIG_DIR, { recursive: true });
    await fs.writeFile(
      this.GLOBAL_CONFIG,
      JSON.stringify(config, null, 2),
      'utf-8'
    );
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
   * Check if global config exists
   */
  static async hasGlobalConfig(): Promise<boolean> {
    try {
      await fs.access(this.GLOBAL_CONFIG);
      return true;
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
          provider: 'anthropic',
          model: 'claude-sonnet-4',
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

    console.log(chalk.dim('\nPriority: cli > env > project > global > default\n'));
  }

  /**
   * Mask sensitive values
   */
  private static maskSensitive(key: string, value: any): string {
    const valueStr = String(value);
    const keyLower = key.toLowerCase();

    if (keyLower.includes('key') || keyLower.includes('token') || keyLower.includes('password')) {
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

    return valueStr;
  }

  /**
   * Get color for source
   */
  private static getSourceColor(source: string): (text: string) => string {
    const colors: Record<string, (text: string) => string> = {
      default: chalk.gray,
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
   * (for passing to external agents like Claude Code, Codex)
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

    // Set provider-specific vars based on provider
    const provider = (config.provider || 'anthropic').toUpperCase();

    if (provider === 'ANTHROPIC') {
      if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl;
      if (config.apiKey) {
        env.ANTHROPIC_API_KEY = config.apiKey;
        env.ANTHROPIC_AUTH_TOKEN = config.apiKey;
      }
      if (config.model) {
        env.ANTHROPIC_MODEL = config.model;
        // For Claude Code subagents
        env.CLAUDE_CODE_SUBAGENT_MODEL = config.model;
      }
    } else if (provider === 'OPENAI') {
      if (config.baseUrl) env.OPENAI_BASE_URL = config.baseUrl;
      if (config.apiKey) env.OPENAI_API_KEY = config.apiKey;
      if (config.model) env.OPENAI_MODEL = config.model;
    } else if (provider === 'AZURE') {
      if (config.baseUrl) env.AZURE_OPENAI_ENDPOINT = config.baseUrl;
      if (config.apiKey) env.AZURE_OPENAI_API_KEY = config.apiKey;
      if (config.model) env.AZURE_OPENAI_DEPLOYMENT = config.model;
    }

    return env;
  }
}
