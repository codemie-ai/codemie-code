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

/**
 * Claude Code values for a LiteLLM gateway (applied only where the user's shell leaves them unset).
 * LiteLLM documents passing the tool-search beta header, `defer_loading` and `tool_reference`
 * through, so tool search is on and experimental betas are allowed. Auto-mode server review is left
 * to Claude Code: a user-run gateway may be a version that carries the safeguards contract.
 */
const LITELLM_CLAUDE_ENV = {
  ENABLE_TOOL_SEARCH: 'true',
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '0',
} as const;

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
    'claude-sonnet-4-6'
  ],
  capabilities: ['streaming', 'tools', 'function-calling'],
  supportsModelInstallation: false,
  supportsStreaming: true,
  agentHooks: {
    claude: { env: LITELLM_CLAUDE_ENV },
    'claude-acp': { env: LITELLM_CLAUDE_ENV },
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
docker run -p 4000:4000 ghcr.io/berriai/litellm:v1.82.3-stable.patch.2
\`\`\`


## Documentation

- LiteLLM Documentation: https://docs.litellm.ai/
- Supported Models: https://docs.litellm.ai/docs/providers
- Proxy Server: https://docs.litellm.ai/docs/simple_proxy
- GitHub: https://github.com/BerriAI/litellm
`
});
