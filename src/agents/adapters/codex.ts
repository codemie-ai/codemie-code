import { AgentAdapter } from '../registry.js';
import { exec } from '../../utils/exec.js';
import { logger } from '../../utils/logger.js';
import { spawn } from 'child_process';

export class CodexAdapter implements AgentAdapter {
  name = 'codex';
  displayName = 'Codex';
  description = 'OpenAI Codex - AI coding assistant';

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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...envOverrides
    };

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

    // Spawn Codex
    const child = spawn('codex', codexArgs, {
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
