import { AgentMetadata, AgentAdapter, AgentConfig } from './types.js';
import { exec } from '../../utils/exec.js';
import { logger } from '../../utils/logger.js';
import { spawn } from 'child_process';
import { SSOGateway } from '../../utils/sso-gateway.js';

/**
 * Base class for all agent adapters
 * Implements common logic shared by external agents
 */
export abstract class BaseAgentAdapter implements AgentAdapter {
  protected ssoGateway: SSOGateway | null = null;

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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...envOverrides
    };

    // Setup SSO gateway if needed
    await this.setupSSOGateway(env);

    // Apply argument transformations
    const transformedArgs = this.metadata.argumentTransform
      ? this.metadata.argumentTransform(args, this.extractConfig(env))
      : args;

    // Run lifecycle hook
    if (this.metadata.lifecycle?.beforeRun) {
      await this.metadata.lifecycle.beforeRun(env, this.extractConfig(env));
    }

    if (!this.metadata.cliCommand) {
      throw new Error(`${this.displayName} has no CLI command configured`);
    }

    try {
      // Spawn the CLI command
      const child = spawn(this.metadata.cliCommand, transformedArgs, {
        stdio: 'inherit',
        env
      });

      return new Promise((resolve, reject) => {
        child.on('error', (error) => {
          reject(new Error(`Failed to start ${this.displayName}: ${error.message}`));
        });

        child.on('exit', async (code) => {
          // Clean up gateway
          if (this.ssoGateway) {
            await this.ssoGateway.stop();
            this.ssoGateway = null;
          }

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
      // Clean up gateway on error
      if (this.ssoGateway) {
        await this.ssoGateway.stop();
        this.ssoGateway = null;
      }
      throw error;
    }
  }

  /**
   * Centralized SSO gateway setup
   * Works for ALL agents based on their metadata
   */
  protected async setupSSOGateway(env: NodeJS.ProcessEnv): Promise<void> {
    // Only activate for ai-run-sso provider
    const isSSOProvider = env.CODEMIE_PROVIDER === 'ai-run-sso';

    if (!isSSOProvider || !this.metadata.ssoConfig?.enabled) {
      return; // No SSO needed
    }

    try {
      // Get the target API URL
      const targetApiUrl = env.CODEMIE_BASE_URL || env.OPENAI_BASE_URL;

      if (!targetApiUrl) {
        throw new Error('No API URL found for SSO authentication');
      }

      // Create and start the SSO gateway
      this.ssoGateway = new SSOGateway({
        targetApiUrl,
        debug: !!(env.DEBUG || env.CODEMIE_DEBUG),
        clientType: this.metadata.ssoConfig.clientType
      });

      const { url } = await this.ssoGateway.start();

      // Override env vars based on agent's ssoConfig.envOverrides
      const { baseUrl, apiKey } = this.metadata.ssoConfig.envOverrides;
      env[baseUrl] = url;                  // Point to local gateway
      env[apiKey] = 'gateway-handled';     // Placeholder

      if (env.DEBUG || env.CODEMIE_DEBUG) {
        logger.info(`[DEBUG] SSO Gateway started for ${this.displayName}`);
        logger.info(`[DEBUG] Gateway URL: ${url}`);
        logger.info(`[DEBUG] Target API: ${targetApiUrl}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`SSO gateway setup failed: ${errorMessage}`);
    }
  }

  /**
   * Apply environment variable mappings from metadata
   */
  protected applyEnvMappings(config: AgentConfig, env: NodeJS.ProcessEnv): void {
    const { envMapping } = this.metadata;

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
