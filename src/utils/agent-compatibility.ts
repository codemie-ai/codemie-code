import chalk from 'chalk';
import { CodeMieConfigOptions } from './config-loader.js';

/**
 * Agent compatibility configuration
 * Defines which providers and models each agent supports
 */
interface AgentCompatibility {
  supportedProviders: string[];
  blockedModelPatterns?: RegExp[];
}

/**
 * Centralized agent compatibility rules
 * Add new agents or update provider support here
 */
const AGENT_COMPATIBILITY: Record<string, AgentCompatibility> = {
  'claude': {
    supportedProviders: ['bedrock', 'openai', 'azure', 'litellm', 'ai-run-sso'],
    blockedModelPatterns: [] // Claude accepts both Claude and GPT models
  },
  'codex': {
    supportedProviders: ['openai', 'azure', 'litellm'],
    blockedModelPatterns: [
      /^claude/i,           // Block any Claude models
      /bedrock.*claude/i    // Block Bedrock Claude models
    ]
  },
  'codemie-code': {
    supportedProviders: ['bedrock', 'openai', 'azure', 'litellm', 'ai-run-sso'],
    blockedModelPatterns: [] // Supports all models via LangChain
  }
};

/**
 * Validation result with helpful error information
 */
export interface CompatibilityResult {
  valid: boolean;
  error?: string;
  suggestions?: string[];
}

/**
 * Validate if an agent supports the configured provider
 */
export function validateProviderCompatibility(
  agentName: string,
  config: CodeMieConfigOptions
): CompatibilityResult {
  const compatibility = AGENT_COMPATIBILITY[agentName];

  // If no rules defined, block by default for security
  if (!compatibility) {
    return {
      valid: false,
      error: `Unknown agent '${agentName}'`,
      suggestions: ['Check agent name and try again']
    };
  }

  const provider = config.provider || 'unknown';

  // Check if provider is in supported list
  if (!compatibility.supportedProviders.includes(provider)) {
    const suggestions = [
      `Supported providers: ${compatibility.supportedProviders.join(', ')}`,
      'Run setup to choose a different provider: codemie setup'
    ];

    // Add direct environment variable configuration hint for Anthropic agents
    if (agentName === 'claude') {
      suggestions.push(
        'Or configure environment variables directly:',
        '  export ANTHROPIC_BASE_URL="https://litellm....."',
        '  export ANTHROPIC_AUTH_TOKEN="sk...."',
        '  export ANTHROPIC_MODEL="claude-4-5-sonnet"'
      );
    }

    return {
      valid: false,
      error: `Provider '${provider}' is not supported by ${agentName}`,
      suggestions
    };
  }

  return { valid: true };
}

/**
 * Validate if an agent supports the configured model
 */
export function validateModelCompatibility(
  agentName: string,
  config: CodeMieConfigOptions
): CompatibilityResult {
  const compatibility = AGENT_COMPATIBILITY[agentName];

  // If no rules defined, block by default for security
  if (!compatibility) {
    return {
      valid: false,
      error: `Unknown agent '${agentName}'`,
      suggestions: ['Check agent name and try again']
    };
  }

  const model = config.model || 'unknown';

  // Check if model matches any blocked pattern
  if (compatibility.blockedModelPatterns) {
    const isBlocked = compatibility.blockedModelPatterns.some(pattern =>
      pattern.test(model)
    );

    if (isBlocked) {
      return {
        valid: false,
        error: `Model '${model}' is not compatible with ${agentName}`,
        suggestions: [
          `${agentName} requires OpenAI-compatible models (e.g., gpt-5, gpt-4o)`,
          `Switch model: codemie config set model gpt-4o`,
          `Override for this session: codemie-${agentName} --model gpt-4o`
        ]
      };
    }
  }

  return { valid: true };
}

/**
 * Display compatibility error with suggestions
 */
export function displayCompatibilityError(
  result: CompatibilityResult,
  logger: { error: (msg: string) => void }
): void {
  if (result.error) {
    logger.error(result.error);
  }

  if (result.suggestions && result.suggestions.length > 0) {
    if (result.suggestions[0].toLowerCase().startsWith('supported')) {
      console.log(chalk.dim(`\n${result.suggestions[0]}`));

      // Display remaining suggestions as numbered options
      if (result.suggestions.length > 1) {
        console.log(chalk.dim('\nOptions:'));
        result.suggestions.slice(1).forEach((suggestion, index) => {
          // Don't number lines that start with whitespace (continuation lines)
          if (suggestion.startsWith(' ')) {
            console.log(chalk.dim(suggestion));
          } else {
            console.log(chalk.dim(`  ${index + 1}. ${suggestion}`));
          }
        });
      }
    } else {
      console.log(chalk.dim('\nOptions:'));
      result.suggestions.forEach((suggestion, index) => {
        // Don't number lines that start with whitespace (continuation lines)
        if (suggestion.startsWith(' ')) {
          console.log(chalk.dim(suggestion));
        } else {
          console.log(chalk.dim(`  ${index + 1}. ${suggestion}`));
        }
      });
    }
  }
}

/**
 * Get supported providers for an agent
 */
export function getSupportedProviders(agentName: string): string[] {
  const compatibility = AGENT_COMPATIBILITY[agentName];
  return compatibility?.supportedProviders || [];
}

/**
 * Check if agent supports a specific provider
 */
export function supportsProvider(agentName: string, provider: string): boolean {
  const compatibility = AGENT_COMPATIBILITY[agentName];
  if (!compatibility) return false; // Default to false for security

  return compatibility.supportedProviders.includes(provider);
}
