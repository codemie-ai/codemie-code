import { AgentAdapter } from '../registry';
import { exec } from '../../utils/exec';
import { logger } from '../../utils/logger';
import { spawn } from 'child_process';

export class ClaudeCodeAdapter implements AgentAdapter {
  name = 'claude';
  displayName = 'Claude Code';
  description = 'Anthropic Claude Code - official CLI tool';

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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...envOverrides
    };

    // Spawn Claude Code
    const child = spawn('claude', args, {
      stdio: 'inherit',
      env
    });

    return new Promise((resolve, reject) => {
      child.on('error', (error) => {
        reject(new Error(`Failed to start Claude Code: ${error.message}`));
      });

      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Claude Code exited with code ${code}`));
        }
      });
    });
  }

  async getVersion(): Promise<string | null> {
    try {
      const result = await exec('claude', ['--version']);
      return result.stdout.trim();
    } catch {
      return null;
    }
  }
}
