import { AgentMetadata, AgentAdapter, AgentConfig, MCPConfigSummary } from './types.js';
import * as npm from '../../utils/processes.js';
import { NpmError } from '../../utils/errors.js';
import { exec } from '../../utils/processes.js';
import { logger } from '../../utils/logger.js';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { CodeMieProxy } from '../../providers/plugins/sso/index.js';
import type { ProxyConfig } from '../../providers/plugins/sso/index.js';
import { ProviderRegistry } from '../../providers/index.js';
import type { CodeMieConfigOptions } from '../../env/types.js';
import { getRandomWelcomeMessage, getRandomGoodbyeMessage } from '../../utils/goodbye-messages.js';
import { renderProfileInfo } from '../../utils/profile.js';
import chalk from 'chalk';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { resolveHomeDir } from '../../utils/paths.js';
import { getMCPConfigSummary as getMCPConfigSummaryUtil } from '../../utils/mcp-config.js';
import {
  executeOnSessionStart,
  executeBeforeRun,
  executeEnrichArgs,
  executeOnSessionEnd,
  executeAfterRun
} from './lifecycle-helpers.js';
import inquirer from 'inquirer';

/**
 * Base class for all agent adapters
 * Implements common logic shared by external agents
 */
export abstract class BaseAgentAdapter implements AgentAdapter {
  protected proxy: CodeMieProxy | null = null;
  protected metadata: AgentMetadata;

  constructor(metadata: AgentMetadata) {
    // Clone metadata to allow runtime overrides (e.g., CLI flags)
    this.metadata = { ...metadata };
  }

  /**
   * Override silent mode at runtime
   * Used by CLI to apply --silent flag
   *
   * @param enabled - Whether to enable silent mode
   */
  setSilentMode(enabled: boolean): void {
    this.metadata.silentMode = enabled;
  }

  /**
   * Get metrics configuration for this agent
   * Used by post-processor to filter/sanitize metrics
   */
  getMetricsConfig(): import('./types.js').AgentMetricsConfig | undefined {
    return this.metadata.metricsConfig;
  }

  /**
   * Get MCP configuration summary for this agent
   * Uses agent's mcpConfig metadata to read config files
   *
   * @param cwd - Current working directory
   * @returns MCP configuration summary with counts and server names
   */
  async getMCPConfigSummary(cwd: string): Promise<MCPConfigSummary> {
    return getMCPConfigSummaryUtil(this.metadata.mcpConfig, cwd);
  }

  get name(): string {
    return this.metadata.name;
  }

  get displayName(): string {
    return this.metadata.displayName;
  }

  get description(): string {
    return this.metadata.description;
  }

  /**
   * Install agent via npm
   */
  async install(): Promise<void> {
    if (!this.metadata.npmPackage) {
      throw new Error(`${this.displayName} is built-in and cannot be installed`);
    }

    try {
      await npm.installGlobal(this.metadata.npmPackage);
    } catch (error: unknown) {
      if (error instanceof NpmError) {
        throw new Error(`Failed to install ${this.displayName}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Uninstall agent via npm
   */
  async uninstall(): Promise<void> {
    if (!this.metadata.npmPackage) {
      throw new Error(`${this.displayName} is built-in and cannot be uninstalled`);
    }

    try {
      await npm.uninstallGlobal(this.metadata.npmPackage);
    } catch (error: unknown) {
      if (error instanceof NpmError) {
        throw new Error(`Failed to uninstall ${this.displayName}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Check if agent is installed (cross-platform)
   */
  async isInstalled(): Promise<boolean> {
    if (!this.metadata.cliCommand) {
      return true; // Built-in agents are always "installed"
    }

    try {
      // Use commandExists which handles Windows (where) vs Unix (which)
      const { commandExists } = await import('../../utils/processes.js');
      return await commandExists(this.metadata.cliCommand);
    } catch {
      return false;
    }
  }

  /**
   * Get agent version
   */
  async getVersion(): Promise<string | null> {
    if (!this.metadata.cliCommand) {
      return null;
    }

    try {
      const result = await exec(this.metadata.cliCommand, ['--version']);
      return result.stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Run the agent
   */
  async run(args: string[], envOverrides?: Record<string, string>): Promise<void> {
    // Check version compatibility before running (for version-managed agents)
    if ('checkVersionCompatibility' in this && typeof (this as any).checkVersionCompatibility === 'function') {
      const compat = await (this as any).checkVersionCompatibility();

      if (compat.isNewer && !this.metadata.silentMode) {
        // User is running a newer (untested) version
        console.log();
        console.log(chalk.yellow(`⚠️  WARNING: You are running ${this.displayName} v${compat.installedVersion}`));
        console.log(chalk.yellow(`   CodeMie has only tested and verified ${this.displayName} v${compat.supportedVersion}`));
        console.log();
        console.log(chalk.white('   Running a newer version may cause compatibility issues with the CodeMie backend proxy.'));
        console.log();
        console.log(chalk.white('   To install the supported version, run:'));
        console.log(chalk.blueBright(`     codemie install ${this.name} --supported`));
        console.log();
        console.log(chalk.white('   Or install a specific version:'));
        console.log(chalk.blueBright(`     codemie install ${this.name} ${compat.supportedVersion}`));
        console.log();

        const { continueAnyway } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'continueAnyway',
            message: 'Continue anyway?',
            default: false,
          },
        ]);

        if (!continueAnyway) {
          console.log(chalk.gray('\nExecution cancelled\n'));
          process.exit(1);
        }

        console.log(); // Add spacing before agent starts
      }
      // Scenario 2: Update available (newer supported version exists, non-blocking info)
      else if (compat.hasUpdate && compat.compatible && !this.metadata.silentMode) {
        console.log();
        console.log(chalk.blue('ℹ️  A new supported version of ' + this.displayName + ' is available!'));
        console.log(chalk.white(`   Current version: v${compat.installedVersion}`));
        console.log(chalk.white(`   Latest version:  v${compat.supportedVersion} `) + chalk.green('(recommended)'));
        console.log();
        console.log(chalk.white('   To update, run:'));
        console.log(chalk.blueBright(`     codemie update ${this.name}`));
        console.log();

        const { continueWithCurrent } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'continueWithCurrent',
            message: 'Continue with current version?',
            default: true,
          },
        ]);

        if (!continueWithCurrent) {
          console.log(chalk.gray('\nExecution cancelled. Please run the update command above.\n'));
          process.exit(1);
        }

        console.log(); // Add spacing before agent starts
      }
    }

    // Generate session ID at the very start - this is the source of truth
    // All components (logger, metrics, proxy) will use this same session ID
    const sessionId = randomUUID();

    // Merge environment variables
    let env: NodeJS.ProcessEnv = {
      ...process.env,
      ...envOverrides,
      CODEMIE_SESSION_ID: sessionId,
      CODEMIE_AGENT: this.metadata.name
    };

    // Initialize logger with session ID
    const { logger } = await import('../../utils/logger.js');
    logger.setSessionId(sessionId);

    // Setup proxy with the session ID (already in env)
    await this.setupProxy(env);

    // Lifecycle hook: session start (provider-aware)
    await executeOnSessionStart(this, this.metadata.lifecycle, this.metadata.name, sessionId, env);

    // Show welcome message with session info (skip in silent mode)
    if (!this.metadata.silentMode) {
      const profileName = env.CODEMIE_PROFILE_NAME || 'default';
      const provider = env.CODEMIE_PROVIDER || 'unknown';
      const cliVersion = env.CODEMIE_CLI_VERSION || 'unknown';
      const model = env.CODEMIE_MODEL || 'unknown';
      const codeMieUrl = env.CODEMIE_URL;

      // Display ASCII logo with configuration
      console.log(
        renderProfileInfo({
          profile: profileName,
          provider,
          model,
          codeMieUrl,
          agent: this.metadata.name,
          cliVersion,
          sessionId
        })
      );

      // Show random welcome message
      console.log(chalk.cyan.bold(getRandomWelcomeMessage()));
      console.log(''); // Empty line for spacing
    }

    // Transform CODEMIE_* → agent-specific env vars (based on envMapping)
    env = this.transformEnvVars(env);

    // Lifecycle hook: beforeRun (provider-aware)
    // Can override or extend env transformations, setup config files
    env = await executeBeforeRun(this, this.metadata.lifecycle, this.metadata.name, env, this.extractConfig(env));

    // Merge modified env back into process.env
    // This ensures enrichArgs hook can access variables set by beforeRun
    Object.assign(process.env, env);

    // Lifecycle hook: enrichArgs (provider-aware)
    // Enrich args with agent-specific defaults (e.g., --profile, --model)
    // Must run AFTER beforeRun so env vars are available
    let enrichedArgs = await executeEnrichArgs(this.metadata.lifecycle, this.metadata.name, args, this.extractConfig(env));

    // Apply argument transformations using declarative flagMappings
    let transformedArgs: string[];

    if (this.metadata.flagMappings) {
      const { transformFlags } = await import('./flag-transform.js');
      transformedArgs = transformFlags(enrichedArgs, this.metadata.flagMappings, this.extractConfig(env));
    } else {
      transformedArgs = enrichedArgs;
    }

    // Log configuration (CODEMIE_* + transformed agent-specific vars)
    logger.debug('=== Agent Configuration ===');
    const codemieVars = Object.keys(env)
      .filter(k => k.startsWith('CODEMIE_'))
      .sort();

    for (const key of codemieVars) {
      const value = env[key];
      if (value) {
        if (key.includes('KEY') || key.includes('TOKEN')) {
          const masked = value.length > 12
            ? value.substring(0, 8) + '***' + value.substring(value.length - 4)
            : '***';
          logger.debug(`${key}: ${masked}`);
        } else if (key === 'CODEMIE_PROFILE_CONFIG') {
          logger.debug(`${key}: <config object>`);
        } else {
          logger.debug(`${key}: ${value}`);
        }
      }
    }

    if (this.metadata.envMapping) {
      const agentVars = [
        ...(this.metadata.envMapping.baseUrl || []),
        ...(this.metadata.envMapping.apiKey || []),
        ...(this.metadata.envMapping.model || [])
      ].sort();

      if (agentVars.length > 0) {
        logger.debug('--- Agent-Specific Variables ---');
        for (const key of agentVars) {
          const value = env[key];
          if (value) {
            if (key.toLowerCase().includes('key') || key.toLowerCase().includes('token')) {
              const masked = value.length > 12
                ? value.substring(0, 8) + '***' + value.substring(value.length - 4)
                : '***';
              logger.debug(`${key}: ${masked}`);
            } else {
              logger.debug(`${key}: ${value}`);
            }
          }
        }
      }
    }

    logger.debug('=== End Configuration ===');

    if (!this.metadata.cliCommand) {
      throw new Error(`${this.displayName} has no CLI command configured`);
    }

    try {
      // Log command execution
      logger.debug(`Executing: ${this.metadata.cliCommand} ${transformedArgs.join(' ')}`);

      // Spawn the CLI command with inherited stdio
      // Resolve full path to handle:
      // - Windows: avoid shell: true deprecation (DEP0190)
      // - Unix: find binaries in ~/.local/bin even when not in PATH
      const isWindows = process.platform === 'win32';
      let commandPath = this.metadata.cliCommand;

      // Try to resolve full path via PATH first
      const { getCommandPath } = await import('../../utils/processes.js');
      const resolvedPath = await getCommandPath(this.metadata.cliCommand);
      if (resolvedPath) {
        commandPath = isWindows && resolvedPath.includes(' ') ? `"${resolvedPath}"` : resolvedPath;
        logger.debug(`Resolved command path: ${resolvedPath}`);
      } else if (!isWindows) {
        // On Unix, check common installation paths if command not found in PATH
        // Native installers (e.g., Claude, Gemini) place binaries in ~/.local/bin/
        const { resolveHomeDir } = await import('../../utils/paths.js');
        const localBinPath = resolveHomeDir(`.local/bin/${this.metadata.cliCommand}`);
        try {
          const fs = await import('fs');
          await fs.promises.access(localBinPath, fs.constants.X_OK);
          commandPath = localBinPath;
          logger.debug(`Found command at local bin path: ${localBinPath}`);
        } catch {
          // Not found in ~/.local/bin either, use original command
        }
      }

      // When shell: true is needed (Windows), merge args into command to avoid DEP0190
      // Node.js deprecation warning: shell mode doesn't escape array arguments, only concatenates them
      let finalCommand = commandPath;
      let finalArgs = transformedArgs;

      if (isWindows && transformedArgs.length > 0) {
        // Quote arguments containing spaces or special characters
        const quotedArgs = transformedArgs.map(arg =>
          arg.includes(' ') || arg.includes('"') ? `"${arg.replace(/"/g, '\\"')}"` : arg
        );
        finalCommand = `${commandPath} ${quotedArgs.join(' ')}`;
        finalArgs = [];
      }

      const child = spawn(finalCommand, finalArgs, {
        stdio: 'inherit',
        env,
        shell: isWindows, // Windows requires shell for .cmd/.bat executables
        windowsHide: isWindows // Hide console window on Windows
      });

      // Define cleanup function for proxy and metrics
      const cleanup = async () => {
        if (this.proxy) {
          logger.debug(`[${this.displayName}] Stopping proxy and flushing analytics...`);
          await this.proxy.stop();
          this.proxy = null;
          logger.debug(`[${this.displayName}] Proxy cleanup complete`);
        }
      };

      // Signal handler for graceful shutdown
      const handleSignal = async (signal: NodeJS.Signals) => {
        logger.debug(`Received ${signal}, cleaning up proxy...`);
        await cleanup();
        // Kill child process gracefully
        child.kill(signal);
      };

      // Register signal handlers
      const sigintHandler = () => handleSignal('SIGINT');
      const sigtermHandler = () => handleSignal('SIGTERM');

      process.once('SIGINT', sigintHandler);
      process.once('SIGTERM', sigtermHandler);

      return new Promise((resolve, reject) => {
        child.on('error', async (error) => {
          // Remove signal handlers to prevent memory leaks
          process.off('SIGINT', sigintHandler);
          process.off('SIGTERM', sigtermHandler);

          // Lifecycle hook: session end (provider-aware)
          await executeOnSessionEnd(this, this.metadata.lifecycle, this.metadata.name, 1, env);

          // Clean up proxy (triggers final sync)
          await cleanup();

          // Lifecycle hook: afterRun (provider-aware)
          await executeAfterRun(this, this.metadata.lifecycle, this.metadata.name, 1, env);

          reject(new Error(`Failed to start ${this.displayName}: ${error.message}`));
        });

        child.on('exit', async (code) => {
          // Remove signal handlers to prevent memory leaks
          process.off('SIGINT', sigintHandler);
          process.off('SIGTERM', sigtermHandler);

          // Show shutting down message (skip in silent mode)
          if (!this.metadata.silentMode) {
            console.log(''); // Empty line for spacing
            console.log(chalk.yellow('Shutting down...'));
          }

          // Grace period: wait for any final API calls from the external agent
          // Many agents (Claude, Gemini) send telemetry/session data on shutdown
          if (this.proxy) {
            const gracePeriodMs = 2000; // 2 seconds
            logger.debug(`[${this.displayName}] Waiting ${gracePeriodMs}ms grace period for final API calls...`);
            await new Promise(resolve => setTimeout(resolve, gracePeriodMs));
          }

          // Lifecycle hook: session end (provider-aware)
          if (code !== null) {
            await executeOnSessionEnd(this, this.metadata.lifecycle, this.metadata.name, code, env);
          }

          // Clean up proxy
          await cleanup();

          // Lifecycle hook: afterRun (provider-aware)
          if (code !== null) {
            await executeAfterRun(this, this.metadata.lifecycle, this.metadata.name, code, env);
          }

          // Show goodbye message with random easter egg (skip in silent mode for ACP)
          if (!this.metadata.silentMode) {
            console.log(chalk.cyan.bold(getRandomGoodbyeMessage()));
            console.log(''); // Spacing before powered by
            console.log(chalk.cyan('Powered by AI/Run CodeMie CLI'));
            console.log(''); // Empty line for spacing
          }

          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`${this.displayName} exited with code ${code}`));
          }
        });
      });
    } catch (error) {

      // Lifecycle hook: session end (provider-aware)
      await executeOnSessionEnd(this, this.metadata.lifecycle, this.metadata.name, 1, env);

      // Clean up proxy on error (triggers final sync)
      if (this.proxy) {
        await this.proxy.stop();
        this.proxy = null;
      }

      // Lifecycle hook: afterRun (provider-aware)
      await executeAfterRun(this, this.metadata.lifecycle, this.metadata.name, 1, env);

      throw error;
    }
  }

  /**
   * Check if proxy should be used for this agent/provider combination
   */
  private shouldUseProxy(env: NodeJS.ProcessEnv): boolean {
    const providerName = env.CODEMIE_PROVIDER;
    if (!providerName) return false;

    const provider = ProviderRegistry.getProvider(providerName);
    const isSSOProvider = provider?.authType === 'sso';
    const isProxyEnabled = this.metadata.ssoConfig?.enabled ?? false;

    return isSSOProvider && isProxyEnabled;
  }

  /**
   * Build proxy configuration from environment variables
   */
  private buildProxyConfig(env: NodeJS.ProcessEnv): ProxyConfig {
    // Get and validate target URL
    const targetApiUrl = env.CODEMIE_BASE_URL;
    if (!targetApiUrl) {
      throw new Error('No API URL found for SSO authentication');
    }

    // Parse timeout (seconds → milliseconds, default 0 = unlimited)
    const timeoutSeconds = env.CODEMIE_TIMEOUT ? parseInt(env.CODEMIE_TIMEOUT, 10) : 0;
    const timeoutMs = timeoutSeconds * 1000;

    // Parse profile config from JSON
    let profileConfig: CodeMieConfigOptions | undefined = undefined;
    if (env.CODEMIE_PROFILE_CONFIG) {
      try {
        profileConfig = JSON.parse(env.CODEMIE_PROFILE_CONFIG) as CodeMieConfigOptions;
      } catch (error) {
        logger.warn('[BaseAgentAdapter] Failed to parse profile config:', error);
      }
    }

    return {
      targetApiUrl,
      clientType: this.metadata.ssoConfig?.clientType || 'unknown',
      timeout: timeoutMs,
      model: env.CODEMIE_MODEL,
      provider: env.CODEMIE_PROVIDER,
      profile: env.CODEMIE_PROFILE_NAME,
      integrationId: env.CODEMIE_INTEGRATION_ID,
      sessionId: env.CODEMIE_SESSION_ID,
      version: env.CODEMIE_CLI_VERSION,
      profileConfig
    };
  }

  /**
   * Centralized proxy setup
   * Works for ALL agents based on their metadata
   */
  protected async setupProxy(env: NodeJS.ProcessEnv): Promise<void> {
    // Early return if proxy not needed
    if (!this.shouldUseProxy(env)) {
      return;
    }

    try {
      // Build proxy configuration
      const config = this.buildProxyConfig(env);

      // Create and start the proxy
      this.proxy = new CodeMieProxy(config);
      const { url } = await this.proxy.start();

      // Update environment with proxy URL
      env.CODEMIE_BASE_URL = url;
      env.CODEMIE_API_KEY = 'proxy-handled';
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Proxy setup failed: ${errorMessage}`);
    }
  }

  /**
   * Extract agent config from environment
   */
  private extractConfig(env: NodeJS.ProcessEnv): AgentConfig {
    return {
      agent: this.metadata.name,               // Add: from metadata
      agentDisplayName: this.metadata.displayName, // Add: from metadata
      provider: env.CODEMIE_PROVIDER,
      model: env.CODEMIE_MODEL,
      baseUrl: env.CODEMIE_BASE_URL,
      apiKey: env.CODEMIE_API_KEY,
      timeout: env.CODEMIE_TIMEOUT ? parseInt(env.CODEMIE_TIMEOUT, 10) : undefined,
      profileName: env.CODEMIE_PROFILE_NAME
    };
  }

  /**
   * Transform CODEMIE_* environment variables to agent-specific format
   * based on agent's envMapping metadata.
   *
   * This is called automatically before lifecycle.beforeRun hook.
   * Agents can still override this in their lifecycle hooks for custom logic.
   *
   * IMPORTANT: Clears existing agent-specific vars first to prevent
   * contamination from previous shell sessions.
   */
  protected transformEnvVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const { envMapping } = this.metadata;

    if (!envMapping) {
      return env;
    }

    // Step 1: Clear all agent-specific env vars first to prevent contamination
    // from previous shell sessions
    if (envMapping.baseUrl) {
      for (const envVar of envMapping.baseUrl) {
        delete env[envVar];
      }
    }
    if (envMapping.apiKey) {
      for (const envVar of envMapping.apiKey) {
        delete env[envVar];
      }
    }
    if (envMapping.model) {
      for (const envVar of envMapping.model) {
        delete env[envVar];
      }
    }

    // Step 2: Set new values from CODEMIE_* vars
    // Transform base URL
    if (env.CODEMIE_BASE_URL && envMapping.baseUrl) {
      for (const envVar of envMapping.baseUrl) {
        env[envVar] = env.CODEMIE_BASE_URL;
      }
    }

    // Transform API key (always set, even if empty)
    if (envMapping.apiKey) {
      const apiKeyValue = env.CODEMIE_API_KEY || '';
      for (const envVar of envMapping.apiKey) {
        env[envVar] = apiKeyValue;
      }
    }

    // Transform model
    if (env.CODEMIE_MODEL && envMapping.model) {
      for (const envVar of envMapping.model) {
        env[envVar] = env.CODEMIE_MODEL;
      }
    }

    return env;
  }

  // ==========================================
  // Lifecycle Helper Utilities
  // ==========================================

  /**
   * Resolve path relative to agent's data directory
   * Uses metadata.dataPaths.home as base
   *
   * Cross-platform: works on Windows/Linux/Mac
   *
   * @param segments - Path segments to join (relative to home)
   * @returns Absolute path in agent's data directory
   *
   * @example
   * // For Gemini with metadata.dataPaths.home = '.gemini'
   * this.resolveDataPath('settings.json')
   * // Returns: /Users/john/.gemini/settings.json (Mac)
   * // Returns: C:\Users\john\.gemini\settings.json (Windows)
   *
   * @example
   * // Multiple segments
   * this.resolveDataPath('tmp', 'cache')
   * // Returns: /Users/john/.gemini/tmp/cache
   */
  protected resolveDataPath(...segments: string[]): string {
    if (!this.metadata.dataPaths?.home) {
      throw new Error(`${this.displayName}: metadata.dataPaths.home is not defined`);
    }

    const home = resolveHomeDir(this.metadata.dataPaths.home);
    return segments.length > 0 ? join(home, ...segments) : home;
  }

  /**
   * Ensure a directory exists, creating it recursively if needed
   * Cross-platform directory creation with proper error handling
   *
   * @param dirPath - Absolute path to directory
   *
   * @example
   * await this.ensureDirectory(this.resolveDataPath())
   * // Creates ~/.gemini if it doesn't exist
   *
   * @example
   * await this.ensureDirectory(this.resolveDataPath('tmp', 'cache'))
   * // Creates ~/.gemini/tmp/cache recursively
   */
  protected async ensureDirectory(dirPath: string): Promise<void> {
    if (!existsSync(dirPath)) {
      await mkdir(dirPath, { recursive: true });
      logger.debug(`[${this.displayName}] Created directory: ${dirPath}`);
    }
  }

  /**
   * Deep merge two objects
   * Adds new fields from source to target, preserves existing values in target
   *
   * @param target - Existing object
   * @param source - Default/new fields to merge
   * @returns Merged object
   *
   * Rules:
   * - If key doesn't exist in target → add it from source
   * - If key exists and both values are objects → recursively merge
   * - If key exists and value is not an object → keep target value (preserve user data)
   */
  private deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>
  ): Record<string, unknown> {
    const result = { ...target };

    for (const key in source) {
      if (!(key in result)) {
        // Key doesn't exist in target → add it from source
        result[key] = source[key];
      } else if (
        typeof result[key] === 'object' &&
        result[key] !== null &&
        !Array.isArray(result[key]) &&
        typeof source[key] === 'object' &&
        source[key] !== null &&
        !Array.isArray(source[key])
      ) {
        // Both are objects (not arrays, not null) → recursive merge
        result[key] = this.deepMerge(
          result[key] as Record<string, unknown>,
          source[key] as Record<string, unknown>
        );
      }
      // Else: key exists → keep existing value (preserve user customization)
    }

    return result;
  }

  /**
   * Ensure a JSON file exists with default content
   * Creates file with proper formatting (2-space indent) if it doesn't exist
   * Updates existing file by merging new fields without overwriting existing values
   *
   * @param filePath - Absolute path to file
   * @param defaultContent - Default content as JavaScript object
   *
   * @example
   * await this.ensureJsonFile(
   *   this.resolveDataPath('settings.json'),
   *   { security: { auth: { selectedType: 'api-key' } } }
   * )
   * // Creates ~/.gemini/settings.json if missing
   * // Or updates existing file by adding missing fields
   */
  protected async ensureJsonFile(
    filePath: string,
    defaultContent: Record<string, unknown>
  ): Promise<void> {
    if (!existsSync(filePath)) {
      // File doesn't exist → create new file with default content
      const content = JSON.stringify(defaultContent, null, 2);
      await writeFile(filePath, content, 'utf-8');
      logger.debug(`[${this.displayName}] Created file: ${filePath}`);
    } else {
      // File exists → merge new fields with existing content
      try {
        const { readFile } = await import('fs/promises');
        const existingRaw = await readFile(filePath, 'utf-8');
        const existingContent = JSON.parse(existingRaw) as Record<string, unknown>;

        // Deep merge: add new fields, preserve existing values
        const merged = this.deepMerge(existingContent, defaultContent);

        // Only write if there are changes
        const existingJson = JSON.stringify(existingContent);
        const mergedJson = JSON.stringify(merged);

        if (mergedJson !== existingJson) {
          const content = JSON.stringify(merged, null, 2);
          await writeFile(filePath, content, 'utf-8');
          logger.debug(`[${this.displayName}] Updated file with new fields: ${filePath}`);
        } else {
          logger.debug(`[${this.displayName}] File up to date: ${filePath}`);
        }
      } catch (error) {
        // If file is corrupted or can't be read, log warning and overwrite with defaults
        logger.warn(`[${this.displayName}] Failed to merge ${filePath}, overwriting with defaults:`, error);
        const content = JSON.stringify(defaultContent, null, 2);
        await writeFile(filePath, content, 'utf-8');
        logger.debug(`[${this.displayName}] Overwrote corrupted file: ${filePath}`);
      }
    }
  }
}
