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

  // Agent Compatibility: Supports Claude agent (Anthropic SDK)
  supportedAgents: ['claude', 'codemie-code'],

  // Recommended models for UI hints (⭐ stars and sorting)
  recommendedModels: [
    'claude-sonnet-4-5',      // Latest Claude Sonnet 4.5
  ],

  supportsModelInstallation: false,

  envExport: (providerConfig) => {
    const env: Record<string, string> = {};
    if (providerConfig.awsProfile) env.CODEMIE_AWS_PROFILE = String(providerConfig.awsProfile);
    if (providerConfig.awsRegion) env.CODEMIE_AWS_REGION = String(providerConfig.awsRegion);
    if (providerConfig.awsSecretAccessKey) env.CODEMIE_AWS_SECRET_ACCESS_KEY = String(providerConfig.awsSecretAccessKey);
    if (providerConfig.maxOutputTokens) env.CODEMIE_MAX_OUTPUT_TOKENS = String(providerConfig.maxOutputTokens);
    if (providerConfig.maxThinkingTokens) env.CODEMIE_MAX_THINKING_TOKENS = String(providerConfig.maxThinkingTokens);
    return env;
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
