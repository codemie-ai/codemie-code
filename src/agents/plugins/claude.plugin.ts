import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';
import { ClaudeAnalyticsAdapter } from '../../analytics/aggregation/adapters/claude.adapter.js';

/**
 * Claude Code Plugin Metadata
 */
const metadata = {
  name: 'claude',
  displayName: 'Claude Code',
  description: 'Claude Code - official Anthropic CLI tool',

  npmPackage: '@anthropic-ai/claude-code',
  cliCommand: 'claude',

  // Data paths (used by lifecycle hooks and analytics)
  dataPaths: {
    home: '~/.claude',
    sessions: 'projects'
  },

  envMapping: {
    baseUrl: ['ANTHROPIC_BASE_URL'],
    apiKey: ['ANTHROPIC_AUTH_TOKEN'],
    model: ['ANTHROPIC_MODEL']
  },

  supportedProviders: ['ollama', 'litellm', 'ai-run-sso'],
  blockedModelPatterns: [], // Accepts both Claude and GPT models

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-claude',
    envOverrides: {
      baseUrl: 'ANTHROPIC_BASE_URL',
      apiKey: 'ANTHROPIC_AUTH_TOKEN'
    }
  },

  lifecycle: {
    async beforeRun(env) {
      // Disable experimental betas if not already set
      if (!env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) {
        env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
      }
      return env;
    }
  }
};

export const ClaudePluginMetadata: AgentMetadata = {
  ...metadata,

  // Analytics adapter uses same metadata (DRY principle!)
  analyticsAdapter: new ClaudeAnalyticsAdapter(metadata)
};

/**
 * Claude Code Adapter
 */
export class ClaudePlugin extends BaseAgentAdapter {
  constructor() {
    super(ClaudePluginMetadata);
  }
}
