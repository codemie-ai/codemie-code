import { AgentAdapter } from '../registry';
import { CodeMieCode } from '../../code';
import { logger } from '../../utils/logger';
import { readFileSync } from 'fs';
import { join } from 'path';

export class CodeMieCodeAdapter implements AgentAdapter {
  name = 'codemie-code';
  displayName = 'CodeMie Code';
  description = 'Built-in AI coding assistant powered by LiteLLM';

  async install(): Promise<void> {
    logger.info('CodeMie Code is built-in and already available');
  }

  async uninstall(): Promise<void> {
    logger.warn('CodeMie Code is built-in and cannot be uninstalled');
  }

  async isInstalled(): Promise<boolean> {
    return true; // Always installed (built-in)
  }

  async run(args: string[], envOverrides?: Record<string, string>): Promise<void> {
    const workingDir = args[0] || process.cwd();

    // Apply environment overrides if provided
    if (envOverrides) {
      Object.assign(process.env, envOverrides);
    }

    const assistant = new CodeMieCode(workingDir);
    await assistant.initialize();
    await assistant.startInteractive();
    await assistant.dispose();
  }

  async getVersion(): Promise<string | null> {
    // Read from package.json
    try {
      const packageJsonPath = join(__dirname, '../../../package.json');
      const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent) as { version: string };
      return packageJson.version;
    } catch {
      return null;
    }
  }
}
