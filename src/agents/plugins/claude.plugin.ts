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

      // Handle AWS Bedrock provider
      if (env.CODEMIE_PROVIDER === 'bedrock') {
        // Enable Bedrock integration (REQUIRED)
        env.CLAUDE_CODE_USE_BEDROCK = '1';

        // Set AWS region (REQUIRED - Claude Code does not read from .aws config)
        if (env.CODEMIE_AWS_REGION) {
          env.AWS_REGION = env.CODEMIE_AWS_REGION;
          env.AWS_DEFAULT_REGION = env.CODEMIE_AWS_REGION;
        }

        // Set AWS credentials based on auth method
        if (env.CODEMIE_AWS_PROFILE) {
          // Using AWS profile
          env.AWS_PROFILE = env.CODEMIE_AWS_PROFILE;
        } else if (env.CODEMIE_API_KEY && env.CODEMIE_AWS_SECRET_ACCESS_KEY) {
          // Using direct credentials
          env.AWS_ACCESS_KEY_ID = env.CODEMIE_API_KEY;
          env.AWS_SECRET_ACCESS_KEY = env.CODEMIE_AWS_SECRET_ACCESS_KEY;
        }

        // Set model (REQUIRED - use ANTHROPIC_MODEL for Bedrock)
        if (env.CODEMIE_MODEL) {
          env.ANTHROPIC_MODEL = env.CODEMIE_MODEL;
        }

        // Set output token settings for Bedrock (only if configured in profile)
        if (env.CODEMIE_MAX_OUTPUT_TOKENS) {
          env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = env.CODEMIE_MAX_OUTPUT_TOKENS;
        }

        if (env.CODEMIE_MAX_THINKING_TOKENS) {
          env.MAX_THINKING_TOKENS = env.CODEMIE_MAX_THINKING_TOKENS;
        }
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
