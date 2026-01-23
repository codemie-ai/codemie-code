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

  // Export custom auth header configuration for litellm provider
  exportEnvVars: (config) => {
    const env: Record<string, string> = {};

    // Export custom authorization header configuration
    // These can be used by agents or litellm proxy for custom auth schemes
    if (config.authHeader) {
      env.CODEMIE_AUTH_HEADER = config.authHeader;
    }
    if (config.authValue) {
      env.CODEMIE_AUTH_VALUE = config.authValue;
    }

    return env;
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
