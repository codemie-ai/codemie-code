import { AgentAdapter } from '../registry';
import { exec } from '../../utils/exec';
import { logger } from '../../utils/logger';
import { spawn } from 'child_process';

export class CodexAdapter implements AgentAdapter {
  name = 'codex';
  displayName = 'Codex';
  description = 'OpenAI Codex - AI coding assistant';

  async install(): Promise<void> {
    logger.info('Installing Codex...');
    try {
      // Install via pip
      await exec('pip', ['install', 'openai-codex'], { timeout: 120000 });
      logger.success('Codex installed successfully');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to install Codex: ${errorMessage}`);
    }
  }

  async uninstall(): Promise<void> {
    logger.info('Uninstalling Codex...');
    try {
      await exec('pip', ['uninstall', '-y', 'openai-codex']);
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...envOverrides
    };

    // Spawn Codex
    const child = spawn('codex', args, {
      stdio: 'inherit',
      env
    });

    return new Promise((resolve, reject) => {
      child.on('error', (error) => {
        reject(new Error(`Failed to start Codex: ${error.message}`));
      });

      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Codex exited with code ${code}`));
        }
      });
    });
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
