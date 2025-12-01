import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';
import { GeminiAnalyticsAdapter } from '../../analytics/aggregation/adapters/gemini.adapter.js';
import { registerCurrentProject } from '../../analytics/aggregation/core/project-mapping.js';
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

  supportedProviders: ['ai-run-sso', 'gemini', 'litellm'],
  blockedModelPatterns: [/^claude/i, /^gpt/i], // Gemini models only

  ssoConfig: {
    enabled: true,
    clientType: 'gemini-cli',
    envOverrides: {
      baseUrl: 'GOOGLE_GEMINI_BASE_URL',
      apiKey: 'GEMINI_API_KEY'
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

  // Gemini CLI uses -m flag for model selection
  argumentTransform: (args, config) => {
    const hasModelArg = args.some((arg, idx) =>
      (arg === '-m' || arg === '--model') && idx < args.length - 1
    );

    if (!hasModelArg && config.model) {
      return ['-m', config.model, ...args];
    }

    return args;
  },

  // Lifecycle hook to ensure settings file exists (uses metadata.dataPaths)
  lifecycle: {
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

      // Register current working directory for project mapping
      // This creates/updates ~/.codemie/gemini-project-mappings.json
      // so analytics can resolve project hashes to actual paths
      registerCurrentProject('gemini', process.cwd());

      return env;
    }
  },

  // Analytics adapter (uses same metadata - DRY principle!)
  analyticsAdapter: new GeminiAnalyticsAdapter(metadata)
};

/**
 * Gemini CLI Adapter
 */
export class GeminiPlugin extends BaseAgentAdapter {
  constructor() {
    super(GeminiPluginMetadata);
  }
}
