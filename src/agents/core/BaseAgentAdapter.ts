import { AgentMetadata, AgentAdapter, AgentConfig } from './types.js';
import { exec } from '../../utils/exec.js';
import { logger } from '../../utils/logger.js';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { CodeMieProxy } from '../../utils/codemie-proxy.js';
import { ProviderRegistry } from '../../providers/core/registry.js';
import { MetricsOrchestrator } from '../../metrics/MetricsOrchestrator.js';
import type { AgentMetricsSupport } from '../../metrics/types.js';
import { getRandomWelcomeMessage, getRandomGoodbyeMessage } from '../../utils/goodbye-messages.js';
import { renderCodeMieLogo } from '../../utils/ascii-logo.js';
import chalk from 'chalk';
import gradient from 'gradient-string';

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

    logger.info(`Installing ${this.displayName}...`);
    try {
      await exec('npm', ['install', '-g', this.metadata.npmPackage], { timeout: 120000 });
      logger.success(`${this.displayName} installed successfully`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to install ${this.displayName}: ${errorMessage}`);
    }
  }

  /**
   * Uninstall agent via npm
   */
  async uninstall(): Promise<void> {
    if (!this.metadata.npmPackage) {
      throw new Error(`${this.displayName} is built-in and cannot be uninstalled`);
    }

    logger.info(`Uninstalling ${this.displayName}...`);
    try {
      await exec('npm', ['uninstall', '-g', this.metadata.npmPackage]);
      logger.success(`${this.displayName} uninstalled successfully`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to uninstall ${this.displayName}: ${errorMessage}`);
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
      const { commandExists } = await import('../../utils/which.js');
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
      CODEMIE_SESSION_ID: sessionId
    };

    // Initialize logger with session ID
    const { logger } = await import('../../utils/logger.js');
    logger.setSessionId(sessionId);

    // Log all environment variables for debugging (sanitized)
    logger.debug('=== Environment Variables (All) ===');
    const sortedEnvKeys = Object.keys(env).sort();
    for (const key of sortedEnvKeys) {
      const value = env[key];
      if (value) {
        // Mask sensitive values (API keys, tokens, secrets)
        if (key.toLowerCase().includes('key') ||
            key.toLowerCase().includes('token') ||
            key.toLowerCase().includes('secret') ||
            key.toLowerCase().includes('password')) {
          const masked = value.length > 12
            ? value.substring(0, 8) + '***' + value.substring(value.length - 4)
            : '***';
          logger.debug(`${key}: ${masked}`);
        } else {
          logger.debug(`${key}: ${value}`);
        }
      }
    }
    logger.debug('=== End Environment Variables ===');

    // Setup metrics orchestrator with the session ID
    const metricsAdapter = this.getMetricsAdapter();
    if (metricsAdapter && env.CODEMIE_PROVIDER) {
      this.metricsOrchestrator = new MetricsOrchestrator({
        agentName: this.metadata.name,
        provider: env.CODEMIE_PROVIDER,
        workingDirectory: process.cwd(),
        metricsAdapter,
        sessionId // Pass the session ID explicitly
      });

      // Take pre-spawn snapshot
      await this.metricsOrchestrator.beforeAgentSpawn();
    }

    // Setup proxy with the session ID (already in env)
    await this.setupProxy(env);

    // Show welcome message with session info
    const profileName = env.CODEMIE_PROFILE_NAME || 'default';
    const provider = env.CODEMIE_PROVIDER || 'unknown';
    const cliVersion = env.CODEMIE_CLI_VERSION || 'unknown';
    const model = env.CODEMIE_MODEL || 'unknown';

    // Display ASCII logo with configuration
    console.log(
      renderCodeMieLogo({
        profile: profileName,
        provider,
        model,
        agent: this.metadata.name,
        cliVersion,
        sessionId
      })
    );

    // Show random welcome message
    console.log(chalk.cyan.bold(getRandomWelcomeMessage()));
    console.log(''); // Empty line for spacing

    // Apply argument transformations
    const transformedArgs = this.metadata.argumentTransform
      ? this.metadata.argumentTransform(args, this.extractConfig(env))
      : args;

    // Run lifecycle hook
    if (this.metadata.lifecycle?.beforeRun) {
      env = await this.metadata.lifecycle.beforeRun(env, this.extractConfig(env));
    }

    if (!this.metadata.cliCommand) {
      throw new Error(`${this.displayName} has no CLI command configured`);
    }

    try {
      // Spawn the CLI command with inherited stdio
      // On Windows, use shell: true to resolve .cmd/.bat executables
      const isWindows = process.platform === 'win32';
      const child = spawn(this.metadata.cliCommand, transformedArgs, {
        stdio: 'inherit',
        env,
        shell: isWindows, // Windows needs shell to resolve .cmd files
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
        child.on('error', (error) => {
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

          // Clean up proxy
          await cleanup();

          // Run afterRun hook
          if (this.metadata.lifecycle?.afterRun && code !== null) {
            await this.metadata.lifecycle.afterRun(code);
          }

          // Show goodbye message with random easter egg
          console.log(chalk.cyan.bold(getRandomGoodbyeMessage()));
          console.log(''); // Spacing before powered by
          // Create custom magenta-purple gradient for CodeMie branding
          const codeMieGradient = gradient(['#ff00ff', '#9933ff']);
          console.log(codeMieGradient('Powered by AI/Run CodeMie CLI'));
          console.log(''); // Empty line for spacing

          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`${this.displayName} exited with code ${code}`));
          }
        });
      });
    } catch (error) {
      // Clean up proxy on error
      if (this.proxy) {
        await this.proxy.stop();
        this.proxy = null;
      }
      throw error;
    }
  }

  /**
   * Centralized proxy setup
   * Works for ALL agents based on their metadata
   */
  protected async setupProxy(env: NodeJS.ProcessEnv): Promise<void> {
    // Check if provider uses SSO authentication
    const providerName = env.CODEMIE_PROVIDER;
    const provider = providerName ? ProviderRegistry.getProvider(providerName) : null;
    const isSSOProvider = provider?.authType === 'sso';

    if (!isSSOProvider || !this.metadata.ssoConfig?.enabled) {
      return; // No proxy needed
    }

    try {
      // Get the target API URL
      const targetApiUrl = env.CODEMIE_BASE_URL || env.OPENAI_BASE_URL;

      if (!targetApiUrl) {
        throw new Error('No API URL found for SSO authentication');
      }

      // Parse timeout from environment (in seconds, convert to milliseconds)
      // Default to 0 (unlimited) for AI requests that can take a long time
      const timeoutSeconds = env.CODEMIE_TIMEOUT ? parseInt(env.CODEMIE_TIMEOUT, 10) : 0;
      const timeoutMs = timeoutSeconds * 1000;

      // Extract config values from environment (includes CLI overrides)
      const config = this.extractConfig(env);

      // Get session ID from environment (set at agent start)
      const sessionId = env.CODEMIE_SESSION_ID;

      // Deserialize profile config (read once at CLI level)
      let profileConfig = undefined;
      if (env.CODEMIE_PROFILE_CONFIG) {
        try {
          profileConfig = JSON.parse(env.CODEMIE_PROFILE_CONFIG);
        } catch (error) {
          logger.debug('[BaseAgentAdapter] Failed to parse profile config:', error);
        }
      }

      // Create and start the proxy with full config
      this.proxy = new CodeMieProxy({
        targetApiUrl,
        clientType: this.metadata.ssoConfig.clientType,
        timeout: timeoutMs,
        model: config.model,
        provider: config.provider,
        profile: env.CODEMIE_PROFILE_NAME,
        integrationId: env.CODEMIE_INTEGRATION_ID,
        sessionId,
        version: env.CODEMIE_CLI_VERSION,
        profileConfig
      });

      const { url } = await this.proxy.start();

      const { baseUrl, apiKey } = this.metadata.ssoConfig.envOverrides;
      env[baseUrl] = url;
      env[apiKey] = 'proxy-handled';
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
      timeout: env.CODEMIE_TIMEOUT ? parseInt(env.CODEMIE_TIMEOUT, 10) : undefined
    };
  }
}
