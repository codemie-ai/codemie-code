import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
  recommendedModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],

  ssoConfig: {
    enabled: true,
    clientType: 'gemini-cli'
  },

  flagMappings: {
    '--task': {
      type: 'flag' as const,
      target: '-p'
    }
  },

  // Data paths (used by lifecycle hooks and analytics)
  dataPaths: {
    home: '~/.gemini',
    sessions: 'tmp/{projectHash}/chats',
    settings: 'settings.json'
  }
};

/**
 * Gemini CLI Plugin Metadata
 */
export const GeminiPluginMetadata: AgentMetadata = {
  ...metadata,

  // Lifecycle hook to ensure settings file exists (uses metadata.dataPaths)
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
    beforeRun: async (env) => {
      const geminiDir = join(homedir(), metadata.dataPaths.home.replace('~/', ''));
      const settingsFile = join(geminiDir, metadata.dataPaths.settings);

      // Create ~/.gemini directory if it doesn't exist
      if (!existsSync(geminiDir)) {
        await mkdir(geminiDir, { recursive: true });
      }

      // Create settings.json if it doesn't exist
      if (!existsSync(settingsFile)) {
        const settings = {
          security: {
            auth: {
              selectedType: 'gemini-api-key'
            }
          }
        };
        await writeFile(settingsFile, JSON.stringify(settings, null, 2));
      }

      return env;
    }
  },

  // Analytics adapter (uses same metadata - DRY principle!)
};

/**
 * Gemini CLI Adapter
 */
export class GeminiPlugin extends BaseAgentAdapter {
  constructor() {
    super(GeminiPluginMetadata);
  }
}
