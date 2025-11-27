import { AgentMetadata, AgentAdapter } from '../core/types.js';
import { logger } from '../../utils/logger.js';
import { CodeMieCode } from '../codemie-code/index.js';
import { loadCodeMieConfig } from '../codemie-code/config.js';
import { join } from 'path';
import { readFileSync } from 'fs';
import { getDirname } from '../../utils/dirname.js';

/**
 * Built-in agent name constant - single source of truth
 */
export const BUILTIN_AGENT_NAME = 'codemie-code';

/**
 * CodeMie-Code Plugin Metadata
 */
export const CodeMieCodePluginMetadata: AgentMetadata = {
  name: BUILTIN_AGENT_NAME,
  displayName: 'CodeMie Native',
  description: 'Built-in LangGraph-based coding assistant',

  npmPackage: null,  // Built-in
  cliCommand: null,  // No external CLI

  envMapping: {},

  supportedProviders: ['bedrock', 'openai', 'azure', 'litellm', 'ai-run-sso'],
  blockedModelPatterns: [],

  // Built-in agent doesn't use SSO gateway (handles auth internally)
  ssoConfig: undefined,

  customOptions: [
    { flags: '--task <task>', description: 'Execute a single task and exit' },
    { flags: '--debug', description: 'Enable debug logging' },
    { flags: '--plan', description: 'Enable planning mode' },
    { flags: '--plan-only', description: 'Plan without execution' }
  ],

  isBuiltIn: true,

  // Custom handler for built-in agent
  customRunHandler: async (args, options) => {
    logger.info('Starting CodeMie Native Agent...');

    try {
      // Check if we have a valid configuration first
      const workingDir = process.cwd();

      try {
        await loadCodeMieConfig(workingDir);
      } catch {
        throw new Error('CodeMie configuration required. Please run: codemie setup');
      }

      const codeMie = new CodeMieCode(workingDir);
      await codeMie.initialize({ debug: options.debug as boolean | undefined });

      if (options.task) {
        await codeMie.executeTaskWithUI(options.task as string, {
          planMode: (options.plan || options.planOnly) as boolean | undefined,
          planOnly: options.planOnly as boolean | undefined
        });
      } else if (args.length > 0) {
        await codeMie.executeTaskWithUI(args.join(' '));
        if (!options.planOnly) {
          await codeMie.startInteractive();
        }
      } else {
        await codeMie.startInteractive();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to run CodeMie Native: ${errorMessage}`);
    }
  },

  customHealthCheck: async () => {
    const result = await CodeMieCode.testConnection(process.cwd());

    if (result.success) {
      logger.success('CodeMie Native is healthy');
      console.log(`Provider: ${result.provider || 'unknown'}`);
      console.log(`Model: ${result.model || 'unknown'}`);
      return true;
    } else {
      logger.error('Health check failed:', result.error);
      return false;
    }
  }
};

/**
 * CodeMie-Code Adapter
 * Custom implementation for built-in agent
 */
export class CodeMieCodePlugin implements AgentAdapter {
  name = BUILTIN_AGENT_NAME;
  displayName = 'CodeMie Native';
  description = 'CodeMie Native Agent - Built-in LangGraph-based coding assistant';

  async install(): Promise<void> {
    logger.info('CodeMie Native is built-in and already available');
  }

  async uninstall(): Promise<void> {
    logger.info('CodeMie Native is built-in and cannot be uninstalled');
  }

  async isInstalled(): Promise<boolean> {
    return true;
  }

  async run(args: string[], envOverrides?: Record<string, string>): Promise<void> {
    // Set environment variables if provided
    if (envOverrides) {
      Object.assign(process.env, envOverrides);
    }

    // Parse options from args
    const options: Record<string, unknown> = {};
    const filteredArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--task' && args[i + 1]) {
        options.task = args[i + 1];
        i++; // Skip next arg
      } else if (arg === '--debug') {
        options.debug = true;
      } else if (arg === '--plan') {
        options.plan = true;
      } else if (arg === '--plan-only') {
        options.planOnly = true;
      } else {
        filteredArgs.push(arg);
      }
    }

    if (!options.debug && process.env.CODEMIE_DEBUG) {
      options.debug = true;
    }

    if (CodeMieCodePluginMetadata.customRunHandler) {
      await CodeMieCodePluginMetadata.customRunHandler(filteredArgs, options, {});
    }
  }

  async getVersion(): Promise<string | null> {
    try {
      const packageJsonPath = join(getDirname(import.meta.url), '../../../package.json');
      const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent) as { version: string };
      return `v${packageJson.version} (built-in)`;
    } catch {
      return 'unknown (built-in)';
    }
  }
}
