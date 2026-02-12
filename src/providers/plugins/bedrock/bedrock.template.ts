/**
 * AWS Bedrock Provider Template
 *
 * Template definition for AWS Bedrock - Amazon's fully managed service for foundation models.
 * Supports Claude, Llama, Mistral, and other models via AWS infrastructure.
 *
 * Auto-registers on import via registerProvider().
 */

import type { ProviderTemplate } from '../../core/types.js';
import { registerProvider } from '../../core/decorators.js';

export const BedrockTemplate = registerProvider<ProviderTemplate>({
  name: 'bedrock',
  displayName: 'AWS Bedrock',
  description: 'Amazon Bedrock - Access Claude, Llama, Mistral & more via AWS',
  defaultBaseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  requiresAuth: true,
  authType: 'api-key', // Using AWS credentials (access key + secret key)
  priority: 15,
  defaultProfileName: 'bedrock',
  recommendedModels: [
    'claude-sonnet-4-5',      // Latest Claude Sonnet 4.5
  ],

  capabilities: ['streaming', 'tools', 'function-calling', 'vision'],
  supportsModelInstallation: false,
  supportsStreaming: true,

  // Environment Variable Export
  exportEnvVars: (config) => {
    const env: Record<string, string> = {};

    // AWS Bedrock-specific environment variables
    if (config.awsProfile) env.CODEMIE_AWS_PROFILE = config.awsProfile;
    if (config.awsRegion) env.CODEMIE_AWS_REGION = config.awsRegion;
    if (config.awsSecretAccessKey) env.CODEMIE_AWS_SECRET_ACCESS_KEY = config.awsSecretAccessKey;

    // Token configuration (for Claude Code with Bedrock)
    if (config.maxOutputTokens) env.CODEMIE_MAX_OUTPUT_TOKENS = String(config.maxOutputTokens);
    if (config.maxThinkingTokens) env.CODEMIE_MAX_THINKING_TOKENS = String(config.maxThinkingTokens);

    return env;
  },

  // Provider-specific agent hooks
  agentHooks: {
    // Wildcard hook: Transform AWS credentials for ALL agents
    '*': {
      beforeRun: async (env, _config) => {
        // Transform CODEMIE_AWS_* → AWS_* (standard AWS environment variables)
        // External agents expect standard AWS env vars, not CODEMIE_AWS_* variants

        // Determine authentication method: profile vs direct credentials
        const usingAwsProfile = env.CODEMIE_AWS_PROFILE &&
                               env.CODEMIE_API_KEY === 'aws-profile';

        if (usingAwsProfile) {
          // Profile-based authentication
          env.AWS_PROFILE = env.CODEMIE_AWS_PROFILE;

          // CRITICAL: When using AWS_PROFILE, must delete explicit credentials
          // AWS SDK prioritizes env vars over profile, causing "invalid token" errors
          delete env.AWS_ACCESS_KEY_ID;
          delete env.AWS_SECRET_ACCESS_KEY;
          delete env.AWS_SESSION_TOKEN;
        } else {
          // Direct credentials (access key + secret key)
          if (env.CODEMIE_API_KEY && env.CODEMIE_API_KEY !== 'aws-profile') {
            env.AWS_ACCESS_KEY_ID = env.CODEMIE_API_KEY;
          }
          if (env.CODEMIE_AWS_SECRET_ACCESS_KEY) {
            env.AWS_SECRET_ACCESS_KEY = env.CODEMIE_AWS_SECRET_ACCESS_KEY;
          }
          // Clear profile to avoid conflicts
          delete env.AWS_PROFILE;
        }

        // AWS Region (REQUIRED - some tools don't read from ~/.aws/config)
        if (env.CODEMIE_AWS_REGION) {
          env.AWS_REGION = env.CODEMIE_AWS_REGION;
          env.AWS_DEFAULT_REGION = env.CODEMIE_AWS_REGION;
        }

        return env;
      }
    },
    // Claude-specific Bedrock configuration
    // https://code.claude.com/docs/en/amazon-bedrock
    'claude': {
      beforeRun: async (env, _config) => {
        // Note: AWS credentials already set by wildcard ('*') hook via automatic chaining

        // Enable Bedrock mode in Claude Code (required)
        env.CLAUDE_CODE_USE_BEDROCK = '1';

        // IMPORTANT: Clear ANTHROPIC_AUTH_TOKEN when using Bedrock
        // Claude Code uses AWS credentials only (not API keys) for Bedrock
        // The envMapping transformation set this to 'aws-profile', which causes
        // "403 Invalid API Key format" errors
        delete env.ANTHROPIC_AUTH_TOKEN;

        // Clear base URL as well - Bedrock doesn't use HTTP endpoints
        delete env.ANTHROPIC_BASE_URL;

        // Set model if specified (Bedrock uses inference profile IDs)
        if (env.CODEMIE_MODEL) {
          env.ANTHROPIC_MODEL = env.CODEMIE_MODEL;
        }

        // Model tier configuration for Bedrock
        // Maps CodeMie tier models to Claude Code environment variables
        if (env.CODEMIE_HAIKU_MODEL) {
          env.ANTHROPIC_DEFAULT_HAIKU_MODEL = env.CODEMIE_HAIKU_MODEL;
        }
        if (env.CODEMIE_SONNET_MODEL) {
          env.ANTHROPIC_DEFAULT_SONNET_MODEL = env.CODEMIE_SONNET_MODEL;
          env.CLAUDE_CODE_SUBAGENT_MODEL = env.CODEMIE_SONNET_MODEL;
        }
        if (env.CODEMIE_OPUS_MODEL) {
          env.ANTHROPIC_DEFAULT_OPUS_MODEL = env.CODEMIE_OPUS_MODEL;
        }

        // Token settings for Bedrock burndown throttling
        // https://code.claude.com/docs/en/amazon-bedrock#output-token-configuration
        // Use user-configured values if available, otherwise use recommended defaults
        env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = env.CODEMIE_MAX_OUTPUT_TOKENS || '4096';
        env.MAX_THINKING_TOKENS = env.CODEMIE_MAX_THINKING_TOKENS || '1024';

        // Clean up intermediate variables
        delete env.CODEMIE_MAX_OUTPUT_TOKENS;
        delete env.CODEMIE_MAX_THINKING_TOKENS;

        return env;
      }
    }
  },

  setupInstructions: `
# AWS Bedrock Setup Instructions

## Prerequisites

1. **AWS Account**: You need an active AWS account with Bedrock access
2. **AWS CLI** (optional but recommended): Install from https://aws.amazon.com/cli/

## Authentication Options

### Option 1: AWS Profile (Recommended)
Use an existing AWS CLI profile configured with:
\`\`\`bash
aws configure --profile your-profile
\`\`\`

### Option 2: Access Keys
Provide AWS Access Key ID and Secret Access Key directly.

## Region Selection

Bedrock is available in specific AWS regions. Common regions:
- **us-east-1** (N. Virginia) - Most models available
- **us-west-2** (Oregon)
- **eu-west-1** (Ireland)
- **ap-southeast-1** (Singapore)

## Model Access

Some models require explicit access request:
1. Go to AWS Console → Bedrock → Model Access
2. Request access to desired models (Claude, Llama, etc.)
3. Wait for approval (usually instant for Claude)

## Using CodeMie with Bedrock

\`\`\`bash
# Setup Bedrock profile
codemie setup
# Select "AWS Bedrock" as provider

# Use with built-in agent
codemie-code --profile bedrock "your task"

# Use with Claude Code agent
codemie-claude --profile bedrock "your task"
\`\`\`

## Documentation

- AWS Bedrock: https://aws.amazon.com/bedrock/
- Supported Models: https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html
- Pricing: https://aws.amazon.com/bedrock/pricing/
`
});
