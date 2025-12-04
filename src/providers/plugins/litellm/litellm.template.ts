/**
 * LiteLLM Provider Template
 *
 * Template definition for LiteLLM proxy.
 * Universal gateway to 100+ LLM providers.
 *
 * Auto-registers on import via registerProvider().
 */

import type { ProviderTemplate } from '../../core/types.js';
import { registerProvider } from '../../core/decorators.js';

export const LiteLLMTemplate = registerProvider<ProviderTemplate>({
  name: 'litellm',
  displayName: 'LiteLLM',
  description: 'Universal gateway to 100+ LLM providers',
  defaultBaseUrl: 'http://localhost:4000',
  requiresAuth: false,
  authType: 'api-key',
  priority: 14,
  defaultProfileName: 'litellm',
  recommendedModels: [
    'claude-4-5-sonnet'
  ],
  capabilities: ['streaming', 'tools', 'function-calling'],
  supportsModelInstallation: false,
  supportsStreaming: true,
  envMapping: {
    // LiteLLM is a universal proxy - set all common env vars for compatibility
    baseUrl: ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'GOOGLE_GEMINI_BASE_URL'],
    apiKey: ['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY'],
    model: ['OPENAI_MODEL', 'ANTHROPIC_MODEL', 'GEMINI_MODEL']
  },
  setupInstructions: `
# LiteLLM Setup Instructions

## Installation

\`\`\`bash
# Install LiteLLM
pip install litellm[proxy]

# Start proxy server
litellm --port 4000
\`\`\`

## Docker

\`\`\`bash
docker run -p 4000:4000 ghcr.io/berriai/litellm:main-latest
\`\`\`


## Documentation

- LiteLLM Documentation: https://docs.litellm.ai/
- Supported Models: https://docs.litellm.ai/docs/providers
- Proxy Server: https://docs.litellm.ai/docs/simple_proxy
- GitHub: https://github.com/BerriAI/litellm
`
});
