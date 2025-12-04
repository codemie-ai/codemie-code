import { AgentMetadata, AgentAdapter, AgentConfig } from './types.js';
import { exec } from '../../utils/exec.js';
import { logger } from '../../utils/logger.js';
import { spawn } from 'child_process';
import { CodeMieProxy } from '../../utils/codemie-proxy.js';
import { ProviderRegistry } from '../../providers/core/registry.js';

/**
 * Base class for all agent adapters
 * Implements common logic shared by external agents
 */
export abstract class BaseAgentAdapter implements AgentAdapter {
  protected proxy: CodeMieProxy | null = null;

  constructor(protected metadata: AgentMetadata) {}

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
   * Check if agent is installed via which command
   */
  async isInstalled(): Promise<boolean> {
    if (!this.metadata.cliCommand) {
      return true; // Built-in agents are always "installed"
    }

    try {
      const result = await exec('which', [this.metadata.cliCommand]);
      return result.code === 0;
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
    logger.info(`Starting ${this.displayName}...`);

    // Merge environment variables
    let env: NodeJS.ProcessEnv = {
      ...process.env,
      ...envOverrides
    };

    // Setup proxy if needed
    await this.setupProxy(env);

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
      const child = spawn(this.metadata.cliCommand, transformedArgs, {
        stdio: 'inherit',
        env
      });

      // Define cleanup function for proxy
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

          // Grace period: wait for any final API calls from the external agent
          // Many agents (Claude, Gemini, Codex) send telemetry/session data on shutdown
          if (this.proxy) {
            const gracePeriodMs = 2000; // 2 seconds
            logger.debug(`[${this.displayName}] Waiting ${gracePeriodMs}ms grace period for final API calls...`);
            await new Promise(resolve => setTimeout(resolve, gracePeriodMs));
          }

          // Clean up proxy
          await cleanup();

          // Run afterRun hook
          if (this.metadata.lifecycle?.afterRun && code !== null) {
            await this.metadata.lifecycle.afterRun(code);
          }

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
      const timeoutSeconds = env.CODEMIE_TIMEOUT ? parseInt(env.CODEMIE_TIMEOUT, 10) : 300;
      const timeoutMs = timeoutSeconds * 1000;

      // Extract config values from environment (includes CLI overrides)
      const config = this.extractConfig(env);

      // Create and start the proxy with full config
      this.proxy = new CodeMieProxy({
        targetApiUrl,
        clientType: this.metadata.ssoConfig.clientType,
        timeout: timeoutMs,
        model: config.model,
        provider: config.provider,
        integrationId: env.CODEMIE_INTEGRATION_ID
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
