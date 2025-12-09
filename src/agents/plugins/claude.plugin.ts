import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';
import { ClaudeMetricsAdapter } from './claude.metrics.js';
import type { AgentMetricsSupport } from '../../metrics/types.js';

/**
 * Claude Code Plugin Metadata
 */
export const ClaudePluginMetadata: AgentMetadata = {
  name: 'claude',
  displayName: 'Claude Code',
  description: 'Claude Code - official Anthropic CLI tool',

  npmPackage: '@anthropic-ai/claude-code',
  cliCommand: 'claude',

  // Data paths (used by lifecycle hooks and analytics)
  dataPaths: {
    home: '~/.claude',
    sessions: 'projects',
    history: 'history.jsonl'  // User prompt history
  },

  envMapping: {
    baseUrl: ['ANTHROPIC_BASE_URL'],
    apiKey: ['ANTHROPIC_AUTH_TOKEN'],
    model: ['ANTHROPIC_MODEL']
  },

  supportedProviders: ['litellm', 'ai-run-sso'],
  blockedModelPatterns: [],

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

/**
 * Claude Code Adapter
 */
export class ClaudePlugin extends BaseAgentAdapter {
  private metricsAdapter: AgentMetricsSupport;

  constructor() {
    super(ClaudePluginMetadata);
    // Pass metadata to metrics adapter to avoid duplication
    this.metricsAdapter = new ClaudeMetricsAdapter('claude', ClaudePluginMetadata);
  }

  /**
   * Get metrics adapter for this agent
   */
  getMetricsAdapter(): AgentMetricsSupport {
    return this.metricsAdapter;
  }
}
