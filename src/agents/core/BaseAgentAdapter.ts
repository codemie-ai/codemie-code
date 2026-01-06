import { AgentMetadata, AgentAdapter, AgentConfig } from './types.js';
import * as npm from '../../utils/processes.js';
import { NpmError } from '../../utils/errors.js';
import { exec } from '../../utils/processes.js';
import { logger } from '../../utils/logger.js';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { CodeMieProxy } from '../../providers/plugins/sso/proxy/sso.proxy.js';
import { ProxyConfig } from '../../providers/plugins/sso/proxy/proxy-types.js';
import { ProviderRegistry } from '../../providers/core/registry.js';
import { MetricsOrchestrator } from './metrics/MetricsOrchestrator.js';
import type { AgentMetricsSupport } from './metrics/types.js';
import type { CodeMieConfigOptions } from '../../env/types.js';
import { getRandomWelcomeMessage, getRandomGoodbyeMessage } from '../../utils/goodbye-messages.js';
import { renderProfileInfo } from '../../utils/profile.js';
import chalk from 'chalk';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { resolveHomeDir } from '../../utils/paths.js';
import {
  executeOnSessionStart,
  executeBeforeRun,
  executeEnrichArgs,
  executeOnSessionEnd,
  executeAfterRun
} from './lifecycle-helpers.js';

/**
 * Base class for all agent adapters
 * Implements common logic shared by external agents
 */
export abstract class BaseAgentAdapter implements AgentAdapter {
  protected proxy: CodeMieProxy | null = null;
  protected metricsOrchestrator: MetricsOrchestrator | null = null;

  constructor(protected metadata: AgentMetadata) {}

  /**
   * Get metrics adapter for this agent (optional)
   * Override in agent plugin if metrics collection is supported
   */
  getMetricsAdapter(): AgentMetricsSupport | null {
    return null;
  }

  /**
   * Get metrics configuration for this agent
   * Used by post-processor to filter/sanitize metrics
   */
  getMetricsConfig(): import('./types.js').AgentMetricsConfig | undefined {
    return this.metadata.metricsConfig;
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

    // Setup metrics orchestrator with the session ID
    // Only create if metrics are enabled for the provider
    const metricsAdapter = this.getMetricsAdapter();
    if (metricsAdapter && env.CODEMIE_PROVIDER) {
      const { METRICS_CONFIG } = await import('./metrics-config.js');

      // Check if metrics are enabled for this provider before creating orchestrator
      if (METRICS_CONFIG.enabled(env.CODEMIE_PROVIDER)) {
        this.metricsOrchestrator = new MetricsOrchestrator({
          agentName: this.metadata.name,
          provider: env.CODEMIE_PROVIDER,
          project: env.CODEMIE_PROJECT,
          workingDirectory: process.cwd(),
          metricsAdapter,
          sessionId // Pass the session ID explicitly
        });

        // Take pre-spawn snapshot
        await this.metricsOrchestrator.beforeAgentSpawn();
      }
    }

    // Setup proxy with the session ID (already in env)
    await this.setupProxy(env);

    // Lifecycle hook: session start (provider-aware)
    await executeOnSessionStart(this, this.metadata.lifecycle, this.metadata.name, sessionId, env);

    // Show welcome message with session info
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

    // Display metrics initialization errors (non-blocking)
    if (this.metricsOrchestrator?.hasInitializationError()) {
      const metricsError = this.metricsOrchestrator.getInitializationError();
      if (metricsError) {
        const { displayWarningMessage } = await import('../../utils/profile.js');
        displayWarningMessage(
          'Metrics Collection Disabled',
          metricsError,
          {
            sessionId,
            agent: this.metadata.name,
            provider,
            model,
            profile: profileName
          },
          { severity: 'warning' }
        );
      }
    }

    // Transform CODEMIE_* → agent-specific env vars (based on envMapping)
    env = this.transformEnvVars(env);

    // Lifecycle hook: beforeRun (provider-aware)
    // Can override or extend env transformations, setup config files
    env = await executeBeforeRun(this, this.metadata.lifecycle, this.metadata.name, env, this.extractConfig(env));

    // Lifecycle hook: enrichArgs (provider-aware)
    // Enrich args with agent-specific defaults (e.g., --profile, --model)
    // Must run AFTER beforeRun so env vars like CODEMIE_CODEX_PROFILE are available
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
      // On Windows, resolve full path to avoid shell: true deprecation (DEP0190)
      const isWindows = process.platform === 'win32';
      let commandPath = this.metadata.cliCommand;

      // Resolve full path on Windows to avoid using shell: true
      if (isWindows) {
        const { getCommandPath } = await import('../../utils/processes.js');
        const resolvedPath = await getCommandPath(this.metadata.cliCommand);
        if (resolvedPath) {
          commandPath = resolvedPath;
          logger.debug(`Resolved command path: ${resolvedPath}`);
        }
      }

      const child = spawn(commandPath, transformedArgs, {
        stdio: 'inherit',
        env,
        shell: isWindows, // Windows requires shell for .cmd/.bat executables
        windowsHide: isWindows // Hide console window on Windows
      });

      // Take post-spawn snapshot after process starts
      if (this.metricsOrchestrator) {
        // Don't await - let it run in background
        this.metricsOrchestrator.afterAgentSpawn().catch(err => {
          logger.error('[MetricsOrchestrator] Post-spawn snapshot failed:', err);
        });
      }

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

          // Finalize metrics with error status
          if (this.metricsOrchestrator) {
            await this.metricsOrchestrator.onAgentExit(1); // Exit code 1 = spawn error
          }

          // Lifecycle hook: session end (provider-aware)
          await executeOnSessionEnd(this, this.metadata.lifecycle, this.metadata.name, 1, env);

          // Clean up proxy
          await cleanup();

          // Lifecycle hook: afterRun (provider-aware)
          await executeAfterRun(this, this.metadata.lifecycle, this.metadata.name, 1, env);

          reject(new Error(`Failed to start ${this.displayName}: ${error.message}`));
        });

        child.on('exit', async (code) => {
          // Remove signal handlers to prevent memory leaks
          process.off('SIGINT', sigintHandler);
          process.off('SIGTERM', sigtermHandler);

          // Show shutting down message
          console.log(''); // Empty line for spacing
          console.log(chalk.yellow('Shutting down...'));

          // Grace period: wait for any final API calls from the external agent
          // Many agents (Claude, Gemini, Codex) send telemetry/session data on shutdown
          if (this.proxy) {
            const gracePeriodMs = 2000; // 2 seconds
            logger.debug(`[${this.displayName}] Waiting ${gracePeriodMs}ms grace period for final API calls...`);
            await new Promise(resolve => setTimeout(resolve, gracePeriodMs));
          }

          // Finalize metrics on agent exit
          if (this.metricsOrchestrator && code !== null) {
            await this.metricsOrchestrator.onAgentExit(code);
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

          // Show goodbye message with random easter egg
          console.log(chalk.cyan.bold(getRandomGoodbyeMessage()));
          console.log(''); // Spacing before powered by
          console.log(chalk.cyan('Powered by AI/Run CodeMie CLI'));
          console.log(''); // Empty line for spacing

          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`${this.displayName} exited with code ${code}`));
          }
        });
      });
    } catch (error) {
      // Finalize metrics with error status
      if (this.metricsOrchestrator) {
        await this.metricsOrchestrator.onAgentExit(1); // Exit code 1 = error
      }

      // Lifecycle hook: session end (provider-aware)
      await executeOnSessionEnd(this, this.metadata.lifecycle, this.metadata.name, 1, env);

      // Clean up proxy on error
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
   * Ensure a JSON file exists with default content
   * Creates file with proper formatting (2-space indent) if it doesn't exist
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
   */
  protected async ensureJsonFile(
    filePath: string,
    defaultContent: Record<string, unknown>
  ): Promise<void> {
    if (!existsSync(filePath)) {
      const content = JSON.stringify(defaultContent, null, 2);
      await writeFile(filePath, content, 'utf-8');
      logger.debug(`[${this.displayName}] Created file: ${filePath}`);
    }
  }
}
