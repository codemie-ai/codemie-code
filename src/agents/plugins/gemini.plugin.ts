import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';

/**
 * Gemini CLI Plugin Metadata
 */
export const GeminiPluginMetadata: AgentMetadata = {
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

  supportedProviders: ['gemini', 'litellm'],
  blockedModelPatterns: [/^claude/i, /^gpt/i], // Gemini models only

  ssoConfig: {
    enabled: true,
    clientType: 'gemini-cli',
    envOverrides: {
      baseUrl: 'GOOGLE_GEMINI_BASE_URL',
      apiKey: 'GEMINI_API_KEY'
    }
  },

  // Gemini CLI uses -m flag for model selection
  argumentTransform: (args, config) => {
    const hasModelArg = args.some((arg, idx) =>
      (arg === '-m' || arg === '--model') && idx < args.length - 1
    );

    if (!hasModelArg && config.model) {
      return ['-m', config.model, ...args];
    }

    return args;
  }
};

/**
 * Gemini CLI Adapter
 */
export class GeminiPlugin extends BaseAgentAdapter {
  constructor() {
    super(GeminiPluginMetadata);
  }
}
