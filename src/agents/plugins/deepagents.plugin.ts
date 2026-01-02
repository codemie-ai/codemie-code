import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';
import { exec } from '../../utils/processes.js';
import { logger } from '../../utils/logger.js';

/**
 * Deep Agents CLI Plugin Metadata
 */
export const DeepAgentsPluginMetadata: AgentMetadata = {
  name: 'deepagents',
  displayName: 'Deep Agents CLI',
  description: 'Terminal interface for building agents with persistent memory',

  npmPackage: 'deepagents-cli',
  cliCommand: 'deepagents-cli',

  envMapping: {
    baseUrl: ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'],
    apiKey: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    model: [] // Model selection: uses Claude Sonnet 4 by default; switches to OpenAI when OPENAI_API_KEY is set
  },

  supportedProviders: ['ollama', 'litellm', 'ai-run-sso'],
  blockedModelPatterns: [], // Accepts both Claude and OpenAI models
  recommendedModels: ['claude-4-5-sonnet', 'gpt-4.1', 'gpt-4o'],

  // Note: Deep Agents CLI doesn't support CLI arguments for API configuration
  // All configuration must be done via environment variables

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-deepagents'
  },

  flagMappings: {
    '--task': {
      type: 'positional',
      target: null
    }
  },

  lifecycle: {
    async beforeRun(env) {
      // Ensure required API key is set
      if (!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
        throw new Error(
          'Deep Agents CLI requires either ANTHROPIC_API_KEY or OPENAI_API_KEY to be set'
        );
      }

      // When using custom base URL (LiteLLM/SSO), prefer OpenAI env vars
      // Deep Agents CLI uses OpenAI SDK internally when OPENAI_BASE_URL is set
      if (env.OPENAI_BASE_URL && !env.OPENAI_API_KEY && env.ANTHROPIC_API_KEY) {
        env.OPENAI_API_KEY = env.ANTHROPIC_API_KEY;
        // Clear ANTHROPIC vars to avoid confusion
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_BASE_URL;
      }

      return env;
    }
  }
};

/**
 * Deep Agents CLI Adapter
 */
export class DeepAgentsPlugin extends BaseAgentAdapter {
  constructor() {
    super(DeepAgentsPluginMetadata);
  }

  /**
   * Install via pip instead of npm
   */
  async install(): Promise<void> {
    logger.info('Installing Deep Agents CLI via Python package manager...');

    try {
      // Try uv first (faster), fall back to pip
      try {
        await exec('uv', ['tool', 'install', 'deepagents-cli'], { timeout: 120000 });
        logger.success('Deep Agents CLI installed successfully via uv');
      } catch {
        // Fall back to pip
        await exec('pip', ['install', 'deepagents-cli'], { timeout: 120000 });
        logger.success('Deep Agents CLI installed successfully via pip');
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Installation failed: ${errorMessage}\n` +
          'Please ensure either uv or pip is installed and available in your PATH.'
      );
    }
  }

  /**
   * Uninstall via pip
   */
  async uninstall(): Promise<void> {
    logger.info('Uninstalling Deep Agents CLI...');

    try {
      // Try uv first, fall back to pip
      try {
        await exec('uv', ['tool', 'uninstall', 'deepagents-cli']);
        logger.success('Deep Agents CLI uninstalled successfully');
      } catch {
        // Fall back to pip
        await exec('pip', ['uninstall', '-y', 'deepagents-cli']);
        logger.success('Deep Agents CLI uninstalled successfully');
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Uninstallation failed: ${errorMessage}`);
    }
  }
}
