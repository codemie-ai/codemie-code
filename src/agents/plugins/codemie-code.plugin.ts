import { AgentMetadata, AgentAdapter } from '../core/types.js';
import { logger } from '../../utils/logger.js';
import { CodeMieCode } from '../codemie-code/index.js';
import { loadCodeMieConfig } from '../codemie-code/config.js';
import { join } from 'path';
import { readFileSync } from 'fs';
import { getDirname } from '../../utils/paths.js';
import { getRandomWelcomeMessage, getRandomGoodbyeMessage } from '../../utils/goodbye-messages.js';
import { renderProfileInfo } from '../../utils/profile.js';
import chalk from 'chalk';

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

  supportedProviders: ['ollama', 'litellm', 'ai-run-sso'],
  blockedModelPatterns: [],

  // Built-in agent doesn't use proxy (handles auth internally)
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
    try {
      // Check if we have a valid configuration first
      const workingDir = process.cwd();

      let config;
      try {
        config = await loadCodeMieConfig(workingDir);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Configuration loading failed:', errorMessage);
        throw new Error(`CodeMie configuration required: ${errorMessage}. Please run: codemie setup`);
      }

      // Show welcome message with session info
      // Read from environment variables (same as BaseAgentAdapter)
      const profileName = process.env.CODEMIE_PROFILE_NAME || config.name || 'default';
      const provider = process.env.CODEMIE_PROVIDER || config.displayProvider || config.provider;
      const model = process.env.CODEMIE_MODEL || config.model;
      const codeMieUrl = process.env.CODEMIE_URL || config.codeMieUrl;
      const sessionId = process.env.CODEMIE_SESSION_ID || 'n/a';
      const cliVersion = process.env.CODEMIE_CLI_VERSION || 'unknown';
      console.log(
        renderProfileInfo({
            profile: profileName,
            provider,
            model,
            codeMieUrl,
            agent: BUILTIN_AGENT_NAME,
            cliVersion,
            sessionId
        })
      );

      // Show random welcome message
      console.log(chalk.cyan.bold(getRandomWelcomeMessage()));
      console.log(''); // Empty line for spacing

      const codeMie = new CodeMieCode(workingDir);
      await codeMie.initialize({ debug: options.debug as boolean | undefined });

      try {
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
      } finally {
        // Show goodbye message
        console.log(''); // Empty line for spacing
        console.log(chalk.cyan.bold(getRandomGoodbyeMessage()));
        console.log(''); // Spacing before powered by
        console.log(chalk.cyan('Powered by AI/Run CodeMie CLI'));
        console.log(''); // Empty line for spacing
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

    if (!options.debug && logger.isDebugMode()) {
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

  getMetricsConfig(): import('../core/types.js').AgentMetricsConfig | undefined {
    // Built-in agent doesn't have specific metrics config
    return undefined;
  }
}
