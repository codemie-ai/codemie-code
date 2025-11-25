import { AgentAdapter } from '../registry.js';
import { exec } from '../../utils/exec.js';
import { logger } from '../../utils/logger.js';
import { spawn } from 'child_process';
import { SSOGateway } from '../../utils/sso-gateway.js';

export class CodexAdapter implements AgentAdapter {
  name = 'codex';
  displayName = 'Codex';
  description = 'OpenAI Codex - AI coding assistant';
  private ssoGateway: SSOGateway | null = null;

  async install(): Promise<void> {
    logger.info('Installing Codex...');
    try {
      // Install via npm
      await exec('npm', ['install', '-g', '@openai/codex'], { timeout: 120000 });
      logger.success('Codex installed successfully');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to install Codex: ${errorMessage}`);
    }
  }

  async uninstall(): Promise<void> {
    logger.info('Uninstalling Codex...');
    try {
      await exec('npm', ['uninstall', '-g', '@openai/codex']);
      logger.success('Codex uninstalled successfully');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to uninstall Codex: ${errorMessage}`);
    }
  }

  async isInstalled(): Promise<boolean> {
    try {
      const result = await exec('which', ['codex']);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  async run(args: string[], envOverrides?: Record<string, string>): Promise<void> {
    logger.info('Starting Codex...');

    // Merge environment variables: process.env < envOverrides
    let env: NodeJS.ProcessEnv = {
      ...process.env,
      ...envOverrides
    };

    // Handle SSO authentication via local gateway if configured
    await this.setupSSOGateway(env);

    // Build Codex arguments with model if specified
    const codexArgs = [...args];

    // Check if model is already specified in args
    const hasModelArg = args.some((arg, idx) =>
      (arg === '-m' || arg === '--model') && idx < args.length - 1
    );

    // If model not in args but available in env, add it
    if (!hasModelArg && (envOverrides?.CODEMIE_MODEL || envOverrides?.OPENAI_MODEL)) {
      const model = envOverrides?.CODEMIE_MODEL || envOverrides?.OPENAI_MODEL;
      if (model) {
        codexArgs.unshift('--model', model);
      }
    }

    try {
      // Spawn Codex
      const child = spawn('codex', codexArgs, {
        stdio: 'inherit',
        env
      });

      return new Promise((resolve, reject) => {
        child.on('error', (error) => {
          reject(new Error(`Failed to start Codex: ${error.message}`));
        });

        child.on('exit', async (code) => {
          // Clean up gateway when codex exits
          if (this.ssoGateway) {
            await this.ssoGateway.stop();
            this.ssoGateway = null;
          }

          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Codex exited with code ${code}`));
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
   * Setup SSO authentication via local gateway if required
   */
  private async setupSSOGateway(env: NodeJS.ProcessEnv): Promise<{ gatewayUrl?: string; port?: number } | null> {
    // Check if we're using SSO provider
    // Only activate SSO gateway for explicit ai-run-sso provider
    // Do NOT activate for litellm or other providers, even if their URLs contain "codemie"
    const isSSOProvider = env.CODEMIE_PROVIDER === 'ai-run-sso';

    if (!isSSOProvider) {
      return null; // No SSO, use regular authentication
    }

    try {
      // Get the target API URL from environment
      const targetApiUrl = env.CODEMIE_BASE_URL || env.OPENAI_BASE_URL;

      if (!targetApiUrl) {
        throw new Error('No API URL found for SSO authentication');
      }

      // Create and start the SSO gateway
      this.ssoGateway = new SSOGateway({
        targetApiUrl,
        debug: !!(env.DEBUG || env.CODEMIE_DEBUG),
        clientType: 'codex-cli'
      });

      const { port, url } = await this.ssoGateway.start();

      // Point codex to use our local gateway
      env.OPENAI_API_BASE = url;
      env.OPENAI_API_KEY = 'gateway-handled'; // Placeholder since gateway handles auth

      if (env.DEBUG || env.CODEMIE_DEBUG) {
        logger.info('[DEBUG] SSO Gateway started for Codex');
        logger.info(`[DEBUG] Gateway URL: ${url}`);
        logger.info(`[DEBUG] Target API: ${targetApiUrl}`);
      }

      return { gatewayUrl: url, port };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`SSO gateway setup failed: ${errorMessage}`);
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const result = await exec('codex', ['--version']);
      return result.stdout.trim();
    } catch {
      return null;
    }
  }
}
