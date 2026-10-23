import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import dotenv from 'dotenv';
import chalk from 'chalk';
import {
  CodeMieConfigOptions,
  ProviderProfile,
  MultiProviderConfig,
  WorkspaceConfig,
  CodeMieIntegrationInfo,
  ConfigWithSource,
  ConfigWithSources,
  CodemieAssistant,
  CodemieSkill,
  StorageScope,
  isMultiProviderConfig,
  isLegacyConfig
} from '../env/types.js';
import { ProviderRegistry } from '../providers/index.js';
import { getCodemieHome, getCodemiePath } from './paths.js';
import { ConfigurationError } from './errors.js';
import { logger } from './logger.js';

// Re-export for backward compatibility
export type { CodeMieConfigOptions, CodeMieIntegrationInfo, ConfigWithSource, ConfigWithSources };

export { StorageScope };

/**
 * Unified configuration loader with priority system:
 * CLI args > Env vars > Project config > Global config > Defaults
 *
 * Supports both:
 * - Legacy single-provider config (version 1)
 * - Multi-provider profiles (version 2)
 */
export class ConfigLoader {
  // Lazy getters so tests that vi.spyOn(paths.getCodemieHome / getCodemiePath)
  // in beforeEach are honored — the previous static-initialized fields were
  // resolved once at class-load time (before any spy could apply), which made
  // the real ~/.codemie path leak into tests. Runtime resolution keeps the
  // production behavior identical and makes the class properly mockable.
  //
  // The setters exist so tests that already worked around the class-load-time
  // issue by overwriting the static value directly (see
  // config-project-override.test.ts "cross-env URL gate" suite) keep working.
  // Production code never assigns these.
  private static _globalConfigDirOverride: string | undefined;
  private static _globalConfigOverride: string | undefined;
  private static get GLOBAL_CONFIG_DIR(): string {
    return this._globalConfigDirOverride ?? getCodemieHome();
  }
  private static set GLOBAL_CONFIG_DIR(value: string) {
    this._globalConfigDirOverride = value;
  }
  private static get GLOBAL_CONFIG(): string {
    return this._globalConfigOverride ?? getCodemiePath('codemie-cli.config.json');
  }
  private static set GLOBAL_CONFIG(value: string) {
    this._globalConfigOverride = value;
  }
  private static LOCAL_CONFIG = '.codemie/codemie-cli.config.json';

  // Cache for multi-provider config
  private static multiProviderCache: MultiProviderConfig | null = null;

  static getConfigLocationLabel(scope: StorageScope, workingDir: string): string {
    return scope === StorageScope.LOCAL
      ? path.join(workingDir, this.LOCAL_CONFIG)
      : `global (${this.GLOBAL_CONFIG})`;
  }

  private static async loadConfigByScope(scope: StorageScope, workingDir: string): Promise<MultiProviderConfig> {
    return scope === StorageScope.GLOBAL
      ? this.loadMultiProviderConfig()
      : this.readLocalConfigForWrite(workingDir);
  }

  private static async saveConfigByScope(scope: StorageScope, workingDir: string, config: MultiProviderConfig): Promise<void> {
    if (scope === StorageScope.GLOBAL) {
      await this.saveMultiProviderConfig(config);
    } else {
      await this.saveLocalMultiProviderConfig(workingDir, config);
    }
  }

  private static getConfiguredActiveProfileName(config: MultiProviderConfig): string | null {
    const profileName = config.activeProfile;
    return profileName && config.profiles[profileName] ? profileName : null;
  }

  private static async loadLocalMultiProviderConfigIfAvailable(
    workingDir: string
  ): Promise<MultiProviderConfig | null> {
    const localConfigPath = path.join(workingDir, this.LOCAL_CONFIG);
    const rawConfig = await this.loadJsonConfig(localConfigPath);
    return isMultiProviderConfig(rawConfig) ? rawConfig : null;
  }

  private static async getEffectiveActiveProfileName(workingDir: string): Promise<string | null> {
    const globalConfig = await this.loadMultiProviderConfig();
    const globalActiveProfileName = this.getConfiguredActiveProfileName(globalConfig);
    const localConfig = await this.loadLocalMultiProviderConfigIfAvailable(workingDir);

    if (!localConfig) {
      return globalActiveProfileName;
    }

    const localProfileName = localConfig.activeProfile;
    const localActiveProfileName = localProfileName && (
      localConfig.profiles[localProfileName] || globalConfig.profiles[localProfileName]
    )
      ? localProfileName
      : null;

    if (localProfileName && !localActiveProfileName) {
      this.warnDanglingLocalProfile(localProfileName, workingDir, globalActiveProfileName);
    }

    return localActiveProfileName ?? globalActiveProfileName;
  }

  // Fallback warning state: console output is opt-in per process (interactive
  // commands only) and printed at most once; hooks and daemons only log it.
  private static fallbackWarningEnabled = false;
  private static fallbackWarningShown = false;
  private static fallbackWarningLogged = false;

  /**
   * Let this process print the dangling local activeProfile warning to stderr.
   * Call from user-facing commands only, never from hooks or background paths.
   */
  static enableFallbackWarning(): void {
    this.fallbackWarningEnabled = true;
  }

  static resetFallbackWarningForTests(): void {
    this.fallbackWarningEnabled = false;
    this.fallbackWarningShown = false;
    this.fallbackWarningLogged = false;
  }

  private static warnDanglingLocalProfile(
    localProfileName: string,
    workingDir: string,
    globalActiveProfileName: string | null
  ): void {
    const localConfigPath = path.join(workingDir, this.LOCAL_CONFIG);
    const message = globalActiveProfileName
      ? `⚠ Local profile "${localProfileName}" not found in ${localConfigPath}; using global profile "${globalActiveProfileName}". Run: codemie profile switch`
      : `⚠ Local profile "${localProfileName}" not found in ${localConfigPath} and no global profile is active. Run: codemie setup`;

    if (!this.fallbackWarningLogged) {
      logger.warn(message);
      this.fallbackWarningLogged = true;
    }

    if (this.fallbackWarningEnabled && !this.fallbackWarningShown && process.stderr.isTTY) {
      console.error(chalk.yellow(message));
      this.fallbackWarningShown = true;
    }
  }

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
      timeout: 0, // Unlimited timeout by default for long AI requests
      debug: false,
      allowedDirs: [],
      ignorePatterns: ['node_modules', '.git', 'dist', 'build']
    };

    const selectedProfileName = await this.resolveProfileName(workingDir, cliOverrides?.name);

    // Determine which local profile to overlay. The local activeProfile represents the
    // team's project defaults for this repository. When a different global profile is
    // selected via --profile, those project defaults should still apply unless the
    // repository explicitly defines an override for the selected profile name.
    const localProfileName = await this.resolveLocalProfileName(workingDir, selectedProfileName);

    // 4. Global config (~/.codemie/codemie-cli.config.json)
    const globalConfig = await this.loadGlobalConfigProfile(selectedProfileName);
    Object.assign(config, this.removeUndefined(globalConfig));

    // 3. Project-local config (.codemie/codemie-cli.config.json) — provider identity
    // (name/model/baseUrl/apiKey/etc.). Repo/tooling-context fields no longer live on
    // the profile; they resolve independently below via resolveWorkspace().
    const localConfig = await this.loadLocalConfigProfile(workingDir, localProfileName);

    // When the selected global profile differs from the team's local profile, the local
    // team profile must not replace provider, model, or credentials — apply none of it.
    const applyProjectOnly = Boolean(
      selectedProfileName && localProfileName && selectedProfileName !== localProfileName
    );
    const effectiveLocalConfig = applyProjectOnly ? {} : localConfig;

    Object.assign(config, this.removeUndefined(effectiveLocalConfig));

    // Workspace fields resolve via resolveProfileWorkspace(): tooling context by
    // whole-object override (local scope, else global), CodeMie identity from the
    // scope of the profile in use.
    const isLocalProfile = Object.keys(effectiveLocalConfig).length > 0;
    const workspace = await this.resolveProfileWorkspace(workingDir, isLocalProfile);
    Object.assign(config, this.removeUndefined(workspace));

    // 2. Environment variables (load .env first if in project)
    const envPath = path.join(workingDir, '.env');
    try {
      await fs.access(envPath);
      dotenv.config({ path: envPath });
    } catch {
      // No .env file, that's fine
    }
    const envConfig = this.loadFromEnv();

    // If a profile is explicitly selected, only apply env vars that aren't profile-specific
    // This prevents environment contamination from overriding the selected profile
    if (cliOverrides?.name) {
      // Only apply env vars for fields not explicitly set in CLI overrides
      const filteredEnvConfig = { ...envConfig };
      const filtered: string[] = [];

      // Don't override profile's baseUrl, apiKey, model, provider unless explicitly in CLI
      if (!cliOverrides.baseUrl && filteredEnvConfig.baseUrl) {
        delete filteredEnvConfig.baseUrl;
        filtered.push('baseUrl');
      }
      if (!cliOverrides.apiKey && filteredEnvConfig.apiKey) {
        delete filteredEnvConfig.apiKey;
        filtered.push('apiKey');
      }
      if (!cliOverrides.model && filteredEnvConfig.model) {
        delete filteredEnvConfig.model;
        filtered.push('model');
      }
      if (!cliOverrides.provider && filteredEnvConfig.provider) {
        delete filteredEnvConfig.provider;
        filtered.push('provider');
      }
      if (!cliOverrides.codeMieUrl && filteredEnvConfig.codeMieUrl) {
        delete filteredEnvConfig.codeMieUrl;
        filtered.push('codeMieUrl');
      }
      if (!cliOverrides.authMethod && filteredEnvConfig.authMethod) {
        delete filteredEnvConfig.authMethod;
        filtered.push('authMethod');
      }
      if (!cliOverrides.codeMieIntegration && filteredEnvConfig.codeMieIntegration) {
        delete filteredEnvConfig.codeMieIntegration;
        filtered.push('codeMieIntegration');
      }

      if (filtered.length > 0 && config.debug) {
        console.log(`[ConfigLoader] Profile protection: filtered environment vars: ${filtered.join(', ')}`);
      }

      Object.assign(config, this.removeUndefined(filteredEnvConfig));
    } else {
      // No explicit profile selected, use normal priority
      Object.assign(config, this.removeUndefined(envConfig));
    }

    // 1. CLI arguments (highest priority)
    if (cliOverrides) {
      Object.assign(config, this.removeUndefined(cliOverrides));
    }

    return config;
  }

  /**
   * Resolve the workspace-level (repo/tooling-context) configuration for a working
   * directory, by whole-object override: the local scope's `workspace` if it is
   * defined, else the global scope's, else `{}`. Never mixes fields between scopes —
   * this is what lets switching the active profile keep workspace context intact.
   */
  static async resolveWorkspace(workingDir: string): Promise<WorkspaceConfig> {
    // `!= null` (loose) deliberately also excludes an explicit `"workspace": null` —
    // e.g. from a hand-edited or externally-written config file — which is not a
    // valid WorkspaceConfig object and must fall back to the next scope rather than
    // being treated as "defined" and passed downstream to Object.entries().
    const localMultiConfig = await this.loadLocalMultiProviderConfigIfAvailable(workingDir);
    if (localMultiConfig?.workspace != null) {
      return localMultiConfig.workspace;
    }

    const globalMultiConfig = await this.loadMultiProviderConfig();
    return globalMultiConfig.workspace ?? {};
  }

  /**
   * Resolve the workspace for the profile in use. Tooling-context fields follow
   * resolveWorkspace(). CodeMie identity fields (codeMieUrl, codeMieProject,
   * codeMieIntegration) come from the scope the profile lives in: a local profile
   * takes them from resolveWorkspace(), a global profile only from the global
   * scope's workspace, so a repo's workspace never retargets global profiles.
   *
   * @param workingDir - Directory whose local config is considered
   * @param isLocalProfile - Whether the profile in use is defined in the local config
   */
  static async resolveProfileWorkspace(workingDir: string, isLocalProfile: boolean): Promise<WorkspaceConfig> {
    const workspace = await this.resolveWorkspace(workingDir);
    if (isLocalProfile) {
      return workspace;
    }

    const globalWorkspace: WorkspaceConfig = (await this.loadMultiProviderConfig()).workspace ?? {};
    const result: Record<string, unknown> = { ...workspace };
    for (const key of this.IDENTITY_KEYS) {
      delete result[key];
      if (globalWorkspace[key] !== undefined) {
        result[key] = globalWorkspace[key];
      }
    }
    return result as WorkspaceConfig;
  }

  /**
   * Scope that supplies CodeMie identity fields for the profile in use — the
   * attribution counterpart of resolveProfileWorkspace().
   */
  private static async resolveIdentitySource(
    workingDir: string,
    isLocalProfile: boolean
  ): Promise<'project' | 'global'> {
    if (!isLocalProfile) {
      return 'global';
    }
    const localMultiConfig = await this.loadLocalMultiProviderConfigIfAvailable(workingDir);
    return localMultiConfig?.workspace != null ? 'project' : 'global';
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
  static async loadGlobalConfigProfile(profileName?: string): Promise<Partial<CodeMieConfigOptions>> {
    const rawConfig = await this.loadJsonConfig(this.GLOBAL_CONFIG);

    // Check if multi-provider config
    if (isMultiProviderConfig(rawConfig)) {
      this.multiProviderCache = rawConfig;
      const profile = profileName || rawConfig.activeProfile;

      // Validate that active profile exists
      if (!profile) {
        return {};
      }

      if (!rawConfig.profiles[profile]) {
        if (profileName) {
          // Profile was specified from a local config and doesn't exist globally — local-only profile, skip global.
          return {};
        }
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
   * Load local (project) config and extract active profile if multi-provider
   * Returns ONLY the fields defined in local config (for overlay on top of global)
   */
  static async loadLocalConfigProfile(
    workingDir: string,
    profileName?: string
  ): Promise<Partial<CodeMieConfigOptions>> {
    const localConfigPath = path.join(workingDir, this.LOCAL_CONFIG);
    const rawConfig = await this.loadJsonConfig(localConfigPath);

    // Check if multi-provider config
    if (isMultiProviderConfig(rawConfig)) {
      const profile = profileName || rawConfig.activeProfile;

      // If profile exists in local config, return it as an override
      if (profile && rawConfig.profiles[profile]) {
        return { ...rawConfig.profiles[profile], name: profile };
      }

      // Otherwise return empty (no local override)
      return {};
    }

    // Legacy single-provider config or partial config
    // Only apply when no specific profile was requested (or requesting 'default').
    // If the caller explicitly selected a named profile (e.g. --profile lite-codex),
    // the legacy local config is a different profile and must not contaminate it.
    if (isLegacyConfig(rawConfig)) {
      if (!profileName || profileName === 'default') {
        return { ...rawConfig, name: 'default' };
      }
      return {};
    }

    // Empty or invalid config
    return {};
  }

  /**
   * Resolve the effective profile name before loading profile data.
   *
   * Local configs can set activeProfile to a profile that exists only globally.
   * In that case, the global profile must be loaded as the base before local
   * overrides are applied.
   */
  private static async resolveProfileName(
    workingDir: string,
    explicitProfileName?: string
  ): Promise<string | undefined> {
    if (explicitProfileName) {
      return explicitProfileName;
    }

    return (await this.getEffectiveActiveProfileName(workingDir)) ?? undefined;
  }

  /**
   * Decide which local profile should be overlaid on top of the selected global profile.
   *
   * Priority:
   * 1. A local profile whose name matches the selected global profile (explicit local override).
   * 2. The repository's local activeProfile, if it points to an existing local profile
   *    (team project defaults).
   * 3. The only local profile defined in the repository (team default when activeProfile
   *    references a global-only profile).
   * 4. The selected global profile name (backward compatibility for single-profile local configs).
   */
  private static async resolveLocalProfileName(
    workingDir: string,
    selectedProfileName?: string
  ): Promise<string | undefined> {
    const localConfigPath = path.join(workingDir, this.LOCAL_CONFIG);
    const localConfig = await this.loadJsonConfig(localConfigPath);

    if (!isMultiProviderConfig(localConfig)) {
      return selectedProfileName;
    }

    const localProfileNames = Object.keys(localConfig.profiles);

    // If the selected global profile has a local counterpart, use it.
    if (selectedProfileName && localConfig.profiles[selectedProfileName]) {
      return selectedProfileName;
    }

    // Otherwise apply the team's local active profile as the project overlay.
    if (localConfig.activeProfile && localConfig.profiles[localConfig.activeProfile]) {
      return localConfig.activeProfile;
    }

    // If the repository defines exactly one local profile, treat it as the team default
    // even when activeProfile references a global-only profile.
    if (localProfileNames.length === 1) {
      return localProfileNames[0];
    }

    // Fallback: keep the original 2-level lookup behavior.
    return selectedProfileName;
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

    // Legacy format - migrate in-memory only; caller decides whether to persist
    if (isLegacyConfig(rawConfig)) {
      const defaultProfile: ProviderProfile = {
        name: 'default',
        ...rawConfig
      };

      return {
        version: 2,
        activeProfile: 'default',
        profiles: { default: defaultProfile }
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
   * Load the local config for a caller that will write it back (migrations).
   * Uses the same classifier as updateLocalConfig(): a missing file yields an
   * empty v2 config with no local profile choice, a partial file is filled, and
   * an unreadable file is refused instead of being read as empty and overwritten.
   */
  static async loadLocalMultiProviderConfig(workingDir: string): Promise<MultiProviderConfig> {
    return this.readLocalConfigForWrite(workingDir);
  }

  /**
   * Read-modify-write the local config. Every key the mutation does not touch is
   * kept; a file that cannot be classified safely is refused and left unchanged.
   */
  static async updateLocalConfig(
    workingDir: string,
    mutate: (config: MultiProviderConfig) => void
  ): Promise<MultiProviderConfig> {
    const config = await this.readLocalConfigForWrite(workingDir);
    mutate(config);
    await this.saveLocalMultiProviderConfig(workingDir, config);
    return config;
  }

  /**
   * Load the local config for a write. A missing file yields an empty v2 config
   * with no local profile choice (activeProfile '').
   */
  private static async readLocalConfigForWrite(workingDir: string): Promise<MultiProviderConfig> {
    const localConfigPath = path.join(workingDir, this.LOCAL_CONFIG);
    let content: string;
    try {
      content = await fs.readFile(localConfigPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { version: 2, activeProfile: '', profiles: {} };
      }
      throw error;
    }

    let raw: unknown;
    try {
      // Strip a UTF-8 BOM some Windows editors add.
      raw = JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
    } catch {
      throw this.unsupportedLocalConfig(localConfigPath, 'invalid JSON');
    }

    return this.classifyLocalConfigForWrite(raw, localConfigPath);
  }

  /**
   * Accept a valid v2 config as-is, fill a partial non-legacy object (e.g. a
   * hand-written assistants/workspace-only file), and refuse everything else.
   */
  private static classifyLocalConfigForWrite(raw: unknown, configPath: string): MultiProviderConfig {
    if (isMultiProviderConfig(raw)) {
      return raw;
    }

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw this.unsupportedLocalConfig(configPath, 'not a JSON object');
    }

    const candidate = raw as Record<string, unknown>;
    if (isLegacyConfig(raw)) {
      throw this.unsupportedLocalConfig(configPath, 'legacy single-provider format');
    }
    if (candidate.version !== undefined && candidate.version !== 2) {
      throw this.unsupportedLocalConfig(configPath, `unsupported version ${String(candidate.version)}`);
    }

    const profiles = candidate.profiles;
    const profilesValid = profiles === undefined || (
      profiles !== null
      && typeof profiles === 'object'
      && !Array.isArray(profiles)
      && Object.values(profiles).every(p => p !== null && typeof p === 'object' && !Array.isArray(p))
    );
    if (!profilesValid) {
      throw this.unsupportedLocalConfig(configPath, '"profiles" must be an object of profile objects');
    }
    if (candidate.activeProfile !== undefined && typeof candidate.activeProfile !== 'string') {
      throw this.unsupportedLocalConfig(configPath, '"activeProfile" must be a string');
    }

    return {
      ...candidate,
      version: 2,
      activeProfile: (candidate.activeProfile as string | undefined) ?? '',
      profiles: (profiles as MultiProviderConfig['profiles'] | undefined) ?? {}
    } as MultiProviderConfig;
  }

  private static unsupportedLocalConfig(configPath: string, reason: string): ConfigurationError {
    return new ConfigurationError(
      `Local config ${configPath} has an unsupported format (${reason}); it was left unchanged.`
    );
  }

  /**
   * Write multi-provider config to the local project config file at
   * <workingDir>/.codemie/codemie-cli.config.json.
   */
  static async saveLocalMultiProviderConfig(workingDir: string, config: MultiProviderConfig): Promise<void> {
    const localConfigPath = path.join(workingDir, this.LOCAL_CONFIG);
    const configDir = path.dirname(localConfigPath);
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(localConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  /**
   * Save multi-provider config
   */
  static async saveMultiProviderConfig(config: MultiProviderConfig): Promise<void> {
    await this.assertGlobalConfigWritable();
    await this.saveGlobalConfig(config as any);
  }

  /**
   * Refuse to overwrite a global file that loadMultiProviderConfig() could not
   * read as v2 or legacy: the config being saved was then built from an empty
   * structure, and writing it would drop every existing profile.
   */
  private static async assertGlobalConfigWritable(): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(this.GLOBAL_CONFIG, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (content.trim() === '') {
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw this.unsupportedGlobalConfig('invalid JSON');
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw this.unsupportedGlobalConfig('not a JSON object');
    }
    const version = (raw as Record<string, unknown>).version;
    if (version !== undefined && !isMultiProviderConfig(raw)) {
      throw this.unsupportedGlobalConfig(
        version === 2 ? 'invalid "profiles" or "activeProfile"' : `unsupported version ${String(version)}`
      );
    }
  }

  private static unsupportedGlobalConfig(reason: string): ConfigurationError {
    return new ConfigurationError(
      `Global config ${this.GLOBAL_CONFIG} has an unsupported format (${reason}); it was left unchanged.`
    );
  }

  static async saveUserEmail(email: string): Promise<void> {
    const config = await this.loadMultiProviderConfig();
    config.userEmail = email;
    await this.saveMultiProviderConfig(config);
  }

  /**
   * CodeMie identity keys. Resolved from the workspace of the scope the active
   * profile lives in — see resolveProfileWorkspace().
   */
  private static readonly IDENTITY_KEYS: (keyof WorkspaceConfig)[] = [
    'codeMieUrl',
    'codeMieProject',
    'codeMieIntegration'
  ];

  /**
   * Keys that belong to WorkspaceConfig (repo/tooling-context) rather than to a
   * ProviderProfile. Used to split a saved profile's input into its profile half
   * and its workspace half — see splitProfileAndWorkspace().
   */
  private static readonly WORKSPACE_KEYS: (keyof WorkspaceConfig)[] = [
    'codeMieUrl',
    'codeMieProject',
    'codeMieIntegration',
    'hooks',
    'plugins',
    'assistants',
    'skillsSearchUrl',
    'claudeAutocompactPct',
    'metrics'
  ];

  /**
   * Partition a profile-shaped input into its provider-identity half and its
   * workspace half, so callers that persist a profile can route each half to
   * where it belongs (profiles[name] vs. the scope's workspace).
   */
  private static splitProfileAndWorkspace(
    input: Partial<CodeMieConfigOptions>
  ): { profile: Partial<ProviderProfile>; workspace: Partial<WorkspaceConfig> } {
    const profile: Partial<ProviderProfile> = { ...(input as any) };
    const workspace: Partial<WorkspaceConfig> = {};

    for (const key of this.WORKSPACE_KEYS) {
      if ((input as any)[key] !== undefined) {
        (workspace as any)[key] = (input as any)[key];
        delete (profile as any)[key];
      }
    }

    return { profile, workspace };
  }

  /**
   * Add or update a profile
   */
  static async saveProfile(profileName: string, profile: ProviderProfile): Promise<void> {
    const config = await this.loadMultiProviderConfig();

    // Strip top-level-only fields that must not live inside a profile
    const { codemieSkills: _skills, codemieAssistants: _assistants, ...cleanProfile } = profile as any;

    const { profile: profileFields, workspace: workspaceFields } = this.splitProfileAndWorkspace(cleanProfile);

    (profileFields as any).name = profileName;
    config.profiles[profileName] = profileFields as ProviderProfile;

    if (Object.keys(this.removeUndefined(workspaceFields)).length > 0) {
      config.workspace = { ...config.workspace, ...workspaceFields };
    }

    // If this is the first profile, make it active
    if (Object.keys(config.profiles).length === 1) {
      config.activeProfile = profileName;
    }

    await this.saveMultiProviderConfig(config);
  }

  /**
   * Add or update a profile in the local config, keeping every other local
   * profile and key. The workspace half is merged into the local workspace.
   *
   * The profile becomes active when the local activeProfile is '' or names a
   * profile that exists in neither scope; an added profile also becomes active
   * when it is the only local profile. Otherwise the local choice is kept.
   */
  static async saveLocalProfile(
    workingDir: string,
    profileName: string,
    input: Partial<CodeMieConfigOptions>,
    options: { isUpdate: boolean }
  ): Promise<{ activated: boolean }> {
    // Top-level-only fields must not live inside a profile.
    const cleanInput: Record<string, unknown> = { ...input };
    delete cleanInput.codemieSkills;
    delete cleanInput.codemieAssistants;
    const { profile: profileFields, workspace: workspaceFields } = this.splitProfileAndWorkspace(
      cleanInput as Partial<CodeMieConfigOptions>
    );
    const globalProfiles = (await this.loadMultiProviderConfig()).profiles;
    let activated = false;

    await this.updateLocalConfig(workingDir, config => {
      config.profiles[profileName] = { ...this.removeUndefined(profileFields), name: profileName } as ProviderProfile;

      const definedWorkspace = this.removeUndefined(workspaceFields);
      if (Object.keys(definedWorkspace).length > 0) {
        config.workspace = { ...config.workspace, ...definedWorkspace };
      }

      const current = config.activeProfile;
      const currentMissing = !current || (!config.profiles[current] && !globalProfiles[current]);
      const onlyLocalProfile = Object.keys(config.profiles).length === 1;
      if (currentMissing || (!options.isUpdate && onlyLocalProfile)) {
        config.activeProfile = profileName;
        activated = true;
      }
    });

    return { activated };
  }

  /**
   * Delete a profile
   * Deletes from the scope that defines the requested profile.
   */
  static async deleteProfile(profileName: string, workingDir: string = process.cwd()): Promise<StorageScope> {
    const scope = await this.getProfileScope(profileName, workingDir);

    if (scope === StorageScope.LOCAL) {
      await this.updateLocalConfig(workingDir, config => {
        delete config.profiles[profileName];
        if (config.activeProfile === profileName) {
          config.activeProfile = this.firstProfileNameOrEmpty(config);
        }
      });
      return scope;
    }

    const activeProfileName = await this.getEffectiveActiveProfileName(workingDir);
    const config = await this.loadMultiProviderConfig();

    delete config.profiles[profileName];

    // If we deleted the active profile, switch to another one (if any exist)
    if (config.activeProfile === profileName) {
      config.activeProfile = this.firstProfileNameOrEmpty(config);
    }

    await this.saveMultiProviderConfig(config);

    if (activeProfileName === profileName) {
      const localConfig = await this.loadLocalMultiProviderConfigIfAvailable(workingDir);
      if (localConfig && localConfig.activeProfile === profileName) {
        // A local active profile may refer to the global profile being deleted.
        // Repair that dangling reference: pick a remaining local profile, or
        // '' (follow the global active profile) when there is none.
        await this.updateLocalConfig(workingDir, local => {
          local.activeProfile = this.firstProfileNameOrEmpty(local);
        });
      }
    }

    return scope;
  }

  private static firstProfileNameOrEmpty(config: MultiProviderConfig): string {
    return Object.keys(config.profiles)[0] ?? '';
  }

  /**
   * Switch active profile
   * If local config exists, updates activeProfile in local config for this repository.
   * Otherwise, updates activeProfile in global config.
   * The selected profile can be defined in either local or global scope.
   */
  static async switchProfile(profileName: string, workingDir: string = process.cwd()): Promise<StorageScope> {
    const localConfig = await this.loadLocalMultiProviderConfigIfAvailable(workingDir);
    const globalConfig = await this.loadMultiProviderConfig();
    const existsLocally = Boolean(localConfig?.profiles[profileName]);
    const existsGlobally = Boolean(globalConfig.profiles[profileName]);

    if (!existsLocally && !existsGlobally) {
      const profiles = await this.listProfiles(workingDir);
      const availableProfiles = profiles.map(p => p.name).join(', ');
      throw new Error(
        `Profile "${profileName}" not found. Available profiles: ${availableProfiles}`
      );
    }

    const hasLocal = await this.hasLocalConfig(workingDir);
    if (hasLocal) {
      await this.updateLocalConfig(workingDir, config => {
        config.activeProfile = profileName;
      });
      return StorageScope.LOCAL;
    } else {
      globalConfig.activeProfile = profileName;
      await this.saveMultiProviderConfig(globalConfig);
      return StorageScope.GLOBAL;
    }
  }

  /**
   * Resolve the scope that owns a profile.
   */
  static async getProfileScope(
    profileName: string,
    workingDir: string = process.cwd()
  ): Promise<StorageScope> {
    const localConfig = await this.loadLocalMultiProviderConfigIfAvailable(workingDir);
    if (localConfig?.profiles[profileName]) {
      return StorageScope.LOCAL;
    }

    const globalConfig = await this.loadMultiProviderConfig();
    if (globalConfig.profiles[profileName]) {
      return StorageScope.GLOBAL;
    }

    const profiles = await this.listProfiles(workingDir);
    const availableProfiles = profiles.map(profile => profile.name).join(', ');
    throw new Error(`Profile "${profileName}" not found. Available profiles: ${availableProfiles}`);
  }

  /**
   * List all profiles
   * Returns profiles from both local (if exists) and global configs
   */
  static async listProfiles(workingDir: string = process.cwd()): Promise<{ name: string; active: boolean; profile: ProviderProfile; source: 'local' | 'global' }[]> {
    const profiles: { name: string; active: boolean; profile: ProviderProfile; source: 'local' | 'global' }[] = [];

    // Load global config first
    const globalConfig = await this.loadMultiProviderConfig();
    const globalActiveProfile = globalConfig.activeProfile;

    // Add global profiles
    Object.entries(globalConfig.profiles).forEach(([name, profile]) => {
      profiles.push({
        name,
        active: false, // Will set active state later
        profile,
        source: 'global'
      });
    });

    // Check if local config exists
    const hasLocal = await this.hasLocalConfig(workingDir);
    let localActiveProfile: string | null = null;

    if (hasLocal) {
      const localConfigPath = path.join(workingDir, this.LOCAL_CONFIG);
      const localConfig = await this.loadJsonConfig(localConfigPath);

      if (isMultiProviderConfig(localConfig)) {
        localActiveProfile = localConfig.activeProfile;

        // Add/override with local profiles
        Object.entries(localConfig.profiles).forEach(([name, profile]) => {
          // Check if profile already exists from global
          const existingIndex = profiles.findIndex(p => p.name === name);

          if (existingIndex >= 0) {
            // Override global profile with local
            profiles[existingIndex] = {
              name,
              active: false,
              profile: profile as ProviderProfile,
              source: 'local'
            };
          } else {
            // Add new local-only profile
            profiles.push({
              name,
              active: false,
              profile: profile as ProviderProfile,
              source: 'local'
            });
          }
        });
      }
    }

    // Determine active profile.
    const activeProfileName = await this.getEffectiveActiveProfileName(workingDir)
      ?? localActiveProfile
      ?? globalActiveProfile;

    // Set active flag
    profiles.forEach(p => {
      p.active = p.name === activeProfileName;
    });

    return profiles;
  }

  /**
   * Get a specific profile
   * Checks local config first, then falls back to global
   */
  static async getProfile(profileName: string, workingDir: string = process.cwd()): Promise<ProviderProfile | null> {
    // Check local config first
    const hasLocal = await this.hasLocalConfig(workingDir);

    if (hasLocal) {
      const localConfigPath = path.join(workingDir, this.LOCAL_CONFIG);
      const localConfig = await this.loadJsonConfig(localConfigPath);

      if (isMultiProviderConfig(localConfig) && localConfig.profiles[profileName]) {
        return localConfig.profiles[profileName] as ProviderProfile;
      }
    }

    // Fall back to global config
    const config = await this.loadMultiProviderConfig();
    return config.profiles[profileName] || null;
  }

  /**
   * Rename a profile in the scope that owns it.
   * The new name must not exist in either scope. Renaming a global profile also
   * repairs this directory's local activeProfile reference to it.
   */
  static async renameProfile(
    oldName: string,
    newName: string,
    workingDir: string = process.cwd()
  ): Promise<StorageScope> {
    const scope = await this.getProfileScope(oldName, workingDir);

    const localConfig = await this.loadLocalMultiProviderConfigIfAvailable(workingDir);
    const globalConfig = await this.loadMultiProviderConfig();
    if (localConfig?.profiles[newName]) {
      throw new Error(`Profile "${newName}" already exists in local config`);
    }
    if (globalConfig.profiles[newName]) {
      throw new Error(`Profile "${newName}" already exists in global config`);
    }

    const renameIn = (config: MultiProviderConfig): void => {
      config.profiles[newName] = { ...config.profiles[oldName], name: newName };
      delete config.profiles[oldName];
      if (config.activeProfile === oldName) {
        config.activeProfile = newName;
      }
    };

    if (scope === StorageScope.LOCAL) {
      await this.updateLocalConfig(workingDir, renameIn);
      return scope;
    }

    renameIn(globalConfig);
    await this.saveMultiProviderConfig(globalConfig);

    if (localConfig?.activeProfile === oldName) {
      await this.updateLocalConfig(workingDir, config => {
        config.activeProfile = newName;
      });
    }

    return scope;
  }

  /**
   * Get active profile name
   * Checks local config first, then global
   */
  static async getActiveProfileName(workingDir: string = process.cwd()): Promise<string | null> {
    return this.getEffectiveActiveProfileName(workingDir);
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
   * Initialize project config with optional overrides
   * Creates .codemie/ directory and initial multi-provider config file
   */
  static async initProjectConfig(
    workingDir: string,
    overrides?: {
      profileName?: string;
      codeMieProject?: string;
      codeMieIntegration?: CodeMieIntegrationInfo;
      [key: string]: any;
    }
  ): Promise<void> {
    const configDir = path.join(workingDir, '.codemie');
    await fs.mkdir(configDir, { recursive: true });

    // Create multi-provider config structure
    const profileName = overrides?.profileName || 'default';
    const rawOverrides: Partial<CodeMieConfigOptions> = {};

    // Collect all overrides (excluding the meta-only profileName key)
    for (const [key, value] of Object.entries(overrides || {})) {
      if (key !== 'profileName' && value !== undefined) {
        (rawOverrides as any)[key] = value;
      }
    }

    const { profile, workspace } = this.splitProfileAndWorkspace(rawOverrides);

    const config: MultiProviderConfig = {
      version: 2,
      activeProfile: profileName,
      profiles: {
        [profileName]: profile as any
      },
      ...(Object.keys(this.removeUndefined(workspace)).length > 0 ? { workspace } : {})
    };

    const configPath = path.join(configDir, 'codemie-cli.config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify(config, null, 2),
      'utf-8'
    );
  }

  static async saveAssistantsToProjectConfig(
    workingDir: string,
    scope: StorageScope,
    assistants: CodemieAssistant[]
  ): Promise<void> {
    const config = await this.loadConfigByScope(scope, workingDir);
    config.codemieAssistants = assistants;
    await this.saveConfigByScope(scope, workingDir, config);
  }

  static async loadSkillsByScope(
    scope: StorageScope,
    workingDir: string,
    // Skills are stored at the top-level MultiProviderConfig, not per-profile.
    // This parameter exists only for call-site compatibility and is intentionally ignored.
    _profileName?: string
  ): Promise<CodemieSkill[]> {
    const config = await this.loadConfigByScope(scope, workingDir);
    const skills = config.codemieSkills ?? [];

    const skillsDir = scope === StorageScope.GLOBAL
      ? path.join(os.homedir(), '.claude', 'skills')
      : path.join(workingDir, '.claude', 'skills');

    const verified = await Promise.all(skills.map(async (skill) => {
      try {
        await fs.access(path.join(skillsDir, skill.slug, 'SKILL.md'));
        return skill;
      } catch {
        return null;
      }
    }));

    return verified.filter((s): s is CodemieSkill => s !== null);
  }

  static async loadAssistantsByScope(
    scope: StorageScope,
    workingDir: string,
    // Assistants are stored at the top-level MultiProviderConfig, not per-profile.
    // This parameter exists only for call-site compatibility and is intentionally ignored.
    _profileName?: string
  ): Promise<CodemieAssistant[]> {
    const config = await this.loadConfigByScope(scope, workingDir);
    const assistants = config.codemieAssistants ?? [];
    const baseDir = scope === StorageScope.GLOBAL ? os.homedir() : workingDir;

    // One fs.access per assistant — acceptable for small lists (<20) but may add
    // measurable latency on agent startup if the list grows large.
    const verified = await Promise.all(assistants.map(async (assistant) => {
      try {
        const isSkill = assistant.registrationMode === 'skill';
        const filePath = isSkill
          ? path.join(baseDir, '.claude', 'skills', assistant.slug, 'SKILL.md')
          : path.join(baseDir, '.claude', 'agents', `${assistant.slug}.md`);
        await fs.access(filePath);
        return assistant;
      } catch {
        return null;
      }
    }));

    return verified.filter((a): a is CodemieAssistant => a !== null);
  }

  static async saveSkillsToProjectConfig(
    workingDir: string,
    scope: StorageScope,
    skills: CodemieSkill[]
  ): Promise<void> {
    const config = await this.loadConfigByScope(scope, workingDir);
    config.codemieSkills = skills;
    await this.saveConfigByScope(scope, workingDir, config);
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
   * Check if local config exists (alias for hasProjectConfig)
   */
  static async hasLocalConfig(workingDir: string = process.cwd()): Promise<boolean> {
    return this.hasProjectConfig(workingDir);
  }

  /**
   * Remove undefined values from object
   */
  private static removeUndefined(obj: any): any {
    if (obj == null) return {};
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

    // Validate hooks configuration if present
    if (config.hooks) {
      this.validateHooksConfiguration(config.hooks);
    }
  }

  /**
   * Validate hooks configuration structure
   * Ensures hooks follow the correct schema and don't contain invalid patterns
   */
  private static validateHooksConfiguration(hooks: any): void {
    if (!hooks || typeof hooks !== 'object') {
      throw new Error('Invalid hooks configuration: must be an object');
    }

    const validEventNames = [
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'Stop',
      'SubagentStop',
      'SessionStart',
      'SessionEnd',
    ];

    for (const [eventName, matchers] of Object.entries(hooks)) {
      // Validate event name
      if (!validEventNames.includes(eventName)) {
        throw new Error(
          `Invalid hook event: "${eventName}". Valid events: ${validEventNames.join(', ')}`
        );
      }

      // Validate matchers array
      if (!Array.isArray(matchers)) {
        throw new Error(
          `Invalid hooks configuration: ${eventName} must be an array of matchers`
        );
      }

      // Validate each matcher
      for (const matcher of matchers as any[]) {
        if (!matcher || typeof matcher !== 'object') {
          throw new Error(
            `Invalid hook matcher in ${eventName}: must be an object`
          );
        }

        // Validate matcher pattern (optional for some events)
        if (matcher.matcher !== undefined && typeof matcher.matcher !== 'string') {
          throw new Error(
            `Invalid hook matcher pattern in ${eventName}: must be a string`
          );
        }

        // Validate hooks array
        if (!Array.isArray(matcher.hooks)) {
          throw new Error(
            `Invalid hook matcher in ${eventName}: hooks must be an array`
          );
        }

        // Validate each hook
        for (const hook of matcher.hooks as any[]) {
          if (!hook || typeof hook !== 'object') {
            throw new Error(
              `Invalid hook in ${eventName}: must be an object`
            );
          }

          // Validate hook type
          if (!hook.type) {
            throw new Error(
              `Invalid hook in ${eventName}: missing required field "type"`
            );
          }

          if (hook.type !== 'command' && hook.type !== 'prompt') {
            throw new Error(
              `Invalid hook type in ${eventName}: "${hook.type}". Must be "command" or "prompt"`
            );
          }

          // Validate command hooks
          if (hook.type === 'command' && !hook.command) {
            throw new Error(
              `Invalid command hook in ${eventName}: missing required field "command"`
            );
          }

          // Validate prompt hooks
          if (hook.type === 'prompt' && !hook.prompt) {
            throw new Error(
              `Invalid prompt hook in ${eventName}: missing required field "prompt"`
            );
          }

          // Validate timeout if present
          if (hook.timeout !== undefined) {
            if (typeof hook.timeout !== 'number' || hook.timeout <= 0) {
              throw new Error(
                `Invalid hook timeout in ${eventName}: must be a positive number`
              );
            }
          }
        }
      }
    }
  }

  /**
   * Load configuration with source tracking
   * Returns full config with source information for each field
   */
  static async loadWithSources(
    workingDir: string = process.cwd(),
    cliOverrides?: Partial<CodeMieConfigOptions>
  ): Promise<ConfigWithSources> {
    const sources: Record<string, ConfigWithSource> = {};

    // Check if local config exists
    const hasLocalConfig = await this.hasProjectConfig(workingDir);

    // Load all config layers
    type ConfigLayer = {
      data: any;
      source: 'default' | 'global' | 'project' | 'env' | 'cli';
    };

    const selectedProfileName = await this.resolveProfileName(workingDir, cliOverrides?.name);
    const localProfileName = await this.resolveLocalProfileName(workingDir, selectedProfileName);

    // Hoisted: global config must be loaded BEFORE the URL-equality gate
    // decision below.
    const globalConfig = await this.loadGlobalConfigProfile(selectedProfileName);
    const localConfig = await this.loadLocalConfigProfile(workingDir, localProfileName);

    const applyProjectOnly = Boolean(
      selectedProfileName && localProfileName && selectedProfileName !== localProfileName
    );
    const effectiveLocalConfig = applyProjectOnly ? {} : localConfig;

    // Workspace (repo/tooling-context) fields resolve independently of profile
    // selection — see resolveWorkspace(). Label the layer by which scope actually
    // supplied it (mirrors resolveWorkspace()'s own local-else-global rule) rather
    // than hardcoding 'project', so --show-sources doesn't misattribute a
    // global-scope-only workspace value to the local config.
    // CodeMie identity fields are labelled separately: they come from the scope of
    // the profile in use (see resolveProfileWorkspace()).
    const localWorkspaceScope = await this.loadLocalMultiProviderConfigIfAvailable(workingDir);
    const workspaceSource: 'project' | 'global' = localWorkspaceScope?.workspace != null ? 'project' : 'global';
    const isLocalProfile = Object.keys(effectiveLocalConfig).length > 0;
    const identitySource = await this.resolveIdentitySource(workingDir, isLocalProfile);
    const profileWorkspace: Record<string, unknown> = {
      ...(await this.resolveProfileWorkspace(workingDir, isLocalProfile))
    };
    const identityWorkspace: Record<string, unknown> = {};
    for (const key of this.IDENTITY_KEYS) {
      if (profileWorkspace[key] !== undefined) {
        identityWorkspace[key] = profileWorkspace[key];
      }
      delete profileWorkspace[key];
    }

    const configs: ConfigLayer[] = [
      {
        data: {
          timeout: 0, // Unlimited timeout by default for long AI requests
          debug: false
        },
        source: 'default'
      },
      {
        data: globalConfig,
        source: 'global'
      },
      {
        data: effectiveLocalConfig,
        source: 'project'
      },
      {
        data: profileWorkspace,
        source: workspaceSource
      },
      {
        data: identityWorkspace,
        source: identitySource
      },
      {
        data: this.loadFromEnv(),
        source: 'env'
      }
    ];

    // Add CLI overrides if provided
    if (cliOverrides) {
      configs.push({
        data: cliOverrides,
        source: 'cli'
      });
    }

    // Track where each value comes from (last one wins)
    for (const { data, source } of configs) {
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined && value !== null) {
          sources[key] = { value, source };
        }
      }
    }

    // Build merged config
    const config = await this.load(workingDir, cliOverrides);

    return {
      config,
      hasLocalConfig,
      sources
    };
  }

  /**
   * Show configuration with source attribution
   */
  static async showWithSources(workingDir: string = process.cwd()): Promise<void> {
    const { sources, hasLocalConfig } = await this.loadWithSources(workingDir);

    console.log(chalk.bold('\nConfiguration Sources:\n'));

    // Show config location
    if (hasLocalConfig) {
      console.log(chalk.yellow(`  Using local config: ${path.join(workingDir, this.LOCAL_CONFIG)}\n`));
    } else {
      console.log(chalk.cyan(`  Using global config: ${this.GLOBAL_CONFIG}\n`));
    }

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
   * Export generic CODEMIE_* environment variables
   *
   * Agents are responsible for transforming CODEMIE_* vars to their own format
   * (e.g., ANTHROPIC_*, OPENAI_*, GEMINI_*) in their lifecycle.beforeRun hooks.
   */
  static exportProviderEnvVars(config: CodeMieConfigOptions): Record<string, string> {
    const env: Record<string, string> = {};

    // Get provider template for auth check and env export
    const providerName = (config.provider || 'openai').toLowerCase();
    const providerTemplate = ProviderRegistry.getProvider(providerName);

    // Set generic CODEMIE_* vars (used by all agents)
    if (config.provider) env.CODEMIE_PROVIDER = config.provider;
    if (config.baseUrl) env.CODEMIE_BASE_URL = config.baseUrl;

    // Set CODEMIE_API_KEY with appropriate default for providers without auth
    const apiKeyValue = config.apiKey || (providerTemplate?.requiresAuth === false ? 'not-required' : '');
    env.CODEMIE_API_KEY = apiKeyValue;

    if (config.model) env.CODEMIE_MODEL = config.model;
    if (config.reasoningEffort) env.CODEMIE_REASONING_EFFORT = config.reasoningEffort;
    // Always emit tier model vars — even when absent — so stale shell values are
    // overridden during env merge in BaseAgentAdapter (EPMCDME-12779).
    // Empty string is falsy, so transformEnvVars() correctly skips absent tiers.
    env.CODEMIE_HAIKU_MODEL = config.haikuModel ?? '';
    env.CODEMIE_SONNET_MODEL = config.sonnetModel ?? '';
    env.CODEMIE_OPUS_MODEL = config.opusModel ?? '';
    if (config.timeout) env.CODEMIE_TIMEOUT = String(config.timeout);
    if (config.debug) env.CODEMIE_DEBUG = String(config.debug);

    // Always export CODEMIE_AUTH_METHOD so that a stale 'jwt' value written to
    // process.env by a previous JWT-authenticated session cannot bleed into the
    // current session and trigger proxy usage for non-JWT providers.
    // Falls back to '' (no auth method) when the provider doesn't set one.
    env.CODEMIE_AUTH_METHOD = config.authMethod ?? '';

    // Provider-specific environment variables (pluggable)
    // Each provider defines its own exportEnvVars function
    if (providerTemplate?.exportEnvVars) {
      const providerEnv = providerTemplate.exportEnvVars(config);
      Object.assign(env, providerEnv);
    }

    return env;
  }
}

// ============================================================================
// Installation ID Management
// ============================================================================

import { randomUUID } from 'node:crypto';

const INSTALLATION_ID_PATH = getCodemiePath('installation-id');

/**
 * Get or create installation ID
 * Returns a persistent UUID that uniquely identifies this CodeMie installation
 */
export async function getInstallationId(): Promise<string> {
  try {
    // Try to read existing ID
    const { readFile } = await import('node:fs/promises');
    const id = await readFile(INSTALLATION_ID_PATH, 'utf-8');
    return id.trim();
  } catch {
    // Generate new ID if file doesn't exist
    const id = randomUUID();

    // Save for future use (directory already exists via getCodemiePath)
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(getCodemieHome(), { recursive: true });
    await writeFile(INSTALLATION_ID_PATH, id, 'utf-8');

    return id;
  }
}

/**
 * Load registered CodeMie assistants from configuration
 * @returns Array of registered assistants, or empty array if none configured
 */
export async function loadRegisteredAssistants(): Promise<CodemieAssistant[]> {
  try {
    const workingDir = process.cwd();
    const [globalAssistants, localAssistants] = await Promise.all([
      ConfigLoader.loadAssistantsByScope(StorageScope.GLOBAL, workingDir).catch(() => [] as CodemieAssistant[]),
      ConfigLoader.loadAssistantsByScope(StorageScope.LOCAL, workingDir).catch(() => [] as CodemieAssistant[]),
    ]);
    const seen = new Set<string>();
    return [...localAssistants, ...globalAssistants].filter(a => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
  } catch {
    return [];
  }
}
