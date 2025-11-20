import { AgentAdapter } from '../registry.js';
import { exec } from '../../utils/exec.js';
import { logger } from '../../utils/logger.js';
import { spawn } from 'child_process';
import { SSOGateway } from '../../utils/sso-gateway.js';

export class ClaudeCodeAdapter implements AgentAdapter {
  name = 'claude';
  displayName = 'Claude Code';
  description = 'Claude Code - official Anthropic CLI tool';
  private ssoGateway: SSOGateway | null = null;

  async install(): Promise<void> {
    logger.info('Installing Claude Code...');
    try {
      // Install via npm
      await exec('npm', ['install', '-g', '@anthropic-ai/claude-code'], { timeout: 120000 });
      logger.success('Claude Code installed successfully');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to install Claude Code: ${errorMessage}`);
    }
  }

  async uninstall(): Promise<void> {
    logger.info('Uninstalling Claude Code...');
    try {
      await exec('npm', ['uninstall', '-g', '@anthropic-ai/claude-code']);
      logger.success('Claude Code uninstalled successfully');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to uninstall Claude Code: ${errorMessage}`);
    }
  }

  async isInstalled(): Promise<boolean> {
    try {
      const result = await exec('which', ['claude']);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  async run(args: string[], envOverrides?: Record<string, string>): Promise<void> {
    logger.info('Starting Claude Code...');

    // Merge environment variables: process.env < envOverrides
    let env: NodeJS.ProcessEnv = {
      ...process.env,
      ...envOverrides
    };

    // Handle SSO authentication via local gateway if configured
    await this.setupSSOGateway(env);

    try {
      // Spawn Claude Code
      const child = spawn('claude', args, {
        stdio: 'inherit',
        env
      });

      return new Promise((resolve, reject) => {
        child.on('error', (error) => {
          reject(new Error(`Failed to start Claude Code: ${error.message}`));
        });

        child.on('exit', async (code) => {
          // Clean up gateway when claude exits
          if (this.ssoGateway) {
            await this.ssoGateway.stop();
            this.ssoGateway = null;
          }

          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Claude Code exited with code ${code}`));
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

  async getVersion(): Promise<string | null> {
    try {
      const result = await exec('claude', ['--version']);
      return result.stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Setup SSO authentication via local gateway if required
   */
  private async setupSSOGateway(env: NodeJS.ProcessEnv): Promise<{ gatewayUrl?: string; port?: number } | null> {
    // Check if we're using SSO provider
    const isSSOProvider = env.CODEMIE_PROVIDER === 'ai-run-sso' ||
                         (env.CODEMIE_BASE_URL?.includes('codemie')) ||
                         (env.OPENAI_BASE_URL?.includes('codemie'));

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
        debug: !!(env.DEBUG || env.CODEMIE_DEBUG)
      });

      const { port, url } = await this.ssoGateway.start();

      // Point claude to use our local gateway
      env.ANTHROPIC_BASE_URL = url;
      env.ANTHROPIC_AUTH_TOKEN = 'gateway-handled'; // Placeholder since gateway handles auth

      if (env.DEBUG || env.CODEMIE_DEBUG) {
        logger.info('[DEBUG] SSO Gateway started for Claude Code');
        logger.info(`[DEBUG] Gateway URL: ${url}`);
        logger.info(`[DEBUG] Target API: ${targetApiUrl}`);
      }

      return { gatewayUrl: url, port };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`SSO gateway setup failed: ${errorMessage}`);
    }
  }
}
