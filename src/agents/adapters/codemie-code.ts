import { AgentAdapter } from '../registry.js';
import { logger } from '../../utils/logger.js';
import { CodeMieCode } from '../codemie-code/index.js';
import { loadCodeMieConfig } from '../codemie-code/config.js';
import { join } from 'path';
import { readFileSync } from 'fs';
import { getDirname } from '../../utils/dirname.js';

export class CodeMieCodeAdapter implements AgentAdapter {
  name = 'codemie-code';
  displayName = 'CodeMie Native';
  description = 'CodeMie Native Agent - Built-in LangGraph-based coding assistant';

  async install(): Promise<void> {
    logger.info('CodeMie Native is built-in and already available');
    // No installation needed - it's built into this package
  }

  async uninstall(): Promise<void> {
    logger.info('CodeMie Native is built-in and cannot be uninstalled');
    // Cannot uninstall built-in agent
  }

  async isInstalled(): Promise<boolean> {
    // Always installed since it's built-in
    return true;
  }

  async run(args: string[], envOverrides?: Record<string, string>): Promise<void> {
    logger.info('Starting CodeMie Native Agent...');

    try {
      // Check if we have a valid configuration first
      const workingDir = process.cwd();

      try {
        await loadCodeMieConfig(workingDir);
      } catch {
        throw new Error('CodeMie configuration required. Please run: codemie setup');
      }

      // Determine the mode based on arguments
      if (args.length === 0) {
        // Interactive mode
        await this.runInteractive(workingDir, envOverrides);
      } else if (args[0] === '--task' && args[1]) {
        // Single task execution
        const task = args.slice(1).join(' ');
        await this.runTask(workingDir, task, envOverrides);
      } else {
        // Default to interactive with arguments as initial message
        const initialMessage = args.join(' ');
        await this.runInteractive(workingDir, envOverrides, initialMessage);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to run CodeMie Native: ${errorMessage}`);
    }
  }

  private async runInteractive(
    workingDir: string,
    envOverrides?: Record<string, string>,
    initialMessage?: string
  ): Promise<void> {
    // Set environment variables if provided
    if (envOverrides) {
      Object.assign(process.env, envOverrides);
    }

    const codeMie = new CodeMieCode(workingDir);
    await codeMie.initialize();

    if (initialMessage) {
      // Execute initial message then continue interactively
      console.log(`> ${initialMessage}`);
      await codeMie.executeTask(initialMessage);
      console.log(''); // Add spacing
    }

    // Start interactive session
    await codeMie.startInteractive();
  }

  private async runTask(
    workingDir: string,
    task: string,
    envOverrides?: Record<string, string>
  ): Promise<void> {
    // Set environment variables if provided
    if (envOverrides) {
      Object.assign(process.env, envOverrides);
    }

    const codeMie = new CodeMieCode(workingDir);
    await codeMie.initialize();

    // Execute single task with modern UI and exit
    const result = await codeMie.executeTaskWithUI(task);
    console.log(result);
  }

  async getVersion(): Promise<string | null> {
    try {
      // Read version from package.json
      const packageJsonPath = join(getDirname(import.meta.url), '../../../package.json');
      const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent) as { version: string };
      return `v${packageJson.version} (built-in)`;
    } catch {
      return 'unknown (built-in)';
    }
  }

  /**
   * Test connection and configuration without starting interactive mode
   */
  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await CodeMieCode.testConnection(process.cwd());
      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}