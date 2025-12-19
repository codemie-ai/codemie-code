import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';
import { ClaudeMetricsAdapter } from './claude.metrics.js';
import type { AgentMetricsSupport } from '../core/metrics/types.js';

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
    home: '.claude',
    sessions: 'projects',
    user_prompts: 'history.jsonl'  // User prompt history
  },

  envMapping: {
    baseUrl: ['ANTHROPIC_BASE_URL'],
    apiKey: ['ANTHROPIC_AUTH_TOKEN'],
    model: ['ANTHROPIC_MODEL']
  },

  supportedProviders: ['litellm', 'ai-run-sso', 'bedrock'],
  blockedModelPatterns: [],
  recommendedModels: ['claude-4-5-sonnet', 'claude-4-opus', 'gpt-4.1'],

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-claude'
  },

  flagMappings: {
    '--task': {
      type: 'flag',
      target: '-p'
    }
  },

  // Metrics configuration: exclude Bash tool errors from API metrics
  metricsConfig: {
    excludeErrorsFromTools: ['Bash']
  },

  lifecycle: {
    // Default hooks for ALL providers (provider-agnostic)
    async beforeRun(env) {
      // Disable experimental betas if not already set
      if (!env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) {
        env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
      }

      // Disable Claude Code telemetry to prevent 404s on /api/event_logging/batch
      // when using proxy (telemetry endpoint doesn't exist on CodeMie backend)
      // https://code.claude.com/docs/en/settings
      if (!env.CLAUDE_CODE_ENABLE_TELEMETRY) {
        env.CLAUDE_CODE_ENABLE_TELEMETRY = '0';
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
