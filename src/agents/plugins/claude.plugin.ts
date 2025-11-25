import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';

/**
 * Claude Code Plugin Metadata
 */
export const ClaudePluginMetadata: AgentMetadata = {
  name: 'claude',
  displayName: 'Claude Code',
  description: 'Claude Code - official Anthropic CLI tool',

  npmPackage: '@anthropic-ai/claude-code',
  cliCommand: 'claude',

  envMapping: {
    baseUrl: ['ANTHROPIC_BASE_URL'],
    apiKey: ['ANTHROPIC_AUTH_TOKEN'],
    model: ['ANTHROPIC_MODEL']
  },

  supportedProviders: ['bedrock', 'openai', 'azure', 'litellm', 'ai-run-sso'],
  blockedModelPatterns: [], // Accepts both Claude and GPT models

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-claude',
    envOverrides: {
      baseUrl: 'ANTHROPIC_BASE_URL',
      apiKey: 'ANTHROPIC_AUTH_TOKEN'
    }
  }
};

/**
 * Claude Code Adapter
 */
export class ClaudePlugin extends BaseAgentAdapter {
  constructor() {
    super(ClaudePluginMetadata);
  }
}
