import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';
import { GeminiMetricsAdapter } from './gemini.metrics.js';
import type { AgentMetricsSupport } from '../core/metrics/types.js';

// Define metadata first (used by both lifecycle and analytics)
const metadata = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  description: 'Google Gemini CLI - AI coding assistant',

  npmPackage: '@google/gemini-cli',
  cliCommand: 'gemini',

  envMapping: {
    baseUrl: ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_BASE_URL'],
    apiKey: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    model: ['GEMINI_MODEL']
  },

  supportedProviders: ['ai-run-sso', 'litellm'],
  blockedModelPatterns: [/^claude/i, /^gpt/i], // Gemini models only
  recommendedModels: ['gemini-3-pro'],

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-gemini'
  },

  flagMappings: {
    '--task': {
      type: 'flag' as const,
      target: '-p'
    }
  },

  // Data paths (used by lifecycle hooks and analytics)
  dataPaths: {
    home: '.gemini',
    sessions: 'tmp/{projectHash}/chats',
    settings: 'settings.json',
    user_prompts: 'logs.json'  // User prompt history (stored in project directories as logs.json)
  }
};

/**
 * Gemini CLI Plugin Metadata
 */
export const GeminiPluginMetadata: AgentMetadata = {
  ...metadata,

  // Lifecycle hook to ensure settings file exists
  // Uses BaseAgentAdapter methods for cross-platform file operations
  lifecycle: {
    enrichArgs: (args, config) => {
      // Gemini CLI uses -m flag for model selection
      const hasModelArg = args.some((arg, idx) =>
        (arg === '-m' || arg === '--model') && idx < args.length - 1
      );

      if (!hasModelArg && config.model) {
        return ['-m', config.model, ...args];
      }

      return args;
    },
    beforeRun: async function(this: BaseAgentAdapter, env: NodeJS.ProcessEnv) {
      // Ensure .gemini directory exists (uses base method)
      await this.ensureDirectory(this.resolveDataPath());

      // Ensure settings.json exists with default content (uses base method)
      await this.ensureJsonFile(
        this.resolveDataPath(metadata.dataPaths.settings),
        {
          security: {
            auth: {
              selectedType: 'gemini-api-key'
            }
          }
        }
      );

      return env;
    }
  }
};

/**
 * Gemini CLI Adapter
 */
export class GeminiPlugin extends BaseAgentAdapter {
  private metricsAdapter: AgentMetricsSupport;

  constructor() {
    super(GeminiPluginMetadata);
    this.metricsAdapter = new GeminiMetricsAdapter(GeminiPluginMetadata);
  }

  getMetricsAdapter(): AgentMetricsSupport {
    return this.metricsAdapter;
  }
}
