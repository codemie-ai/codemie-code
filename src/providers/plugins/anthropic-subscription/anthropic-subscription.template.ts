/**
 * Anthropic Subscription Provider Template
 *
 * Template definition for native Claude Code authentication using
 * an existing Anthropic subscription login.
 *
 * Auto-registers on import via registerProvider().
 */

import type { ProviderTemplate } from '../../core/types.js';
import { registerProvider } from '../../core/decorators.js';
import { ensureApiBase } from '../../core/codemie-auth-helpers.js';

export const AnthropicSubscriptionTemplate = registerProvider<ProviderTemplate>({
  name: 'anthropic-subscription',
  displayName: 'Anthropic Subscription',
  description: 'Native Claude Code authentication using your Claude subscription',
  defaultBaseUrl: 'https://api.anthropic.com',
  requiresAuth: false,
  authType: 'none',
  priority: 16,
  defaultProfileName: 'anthropic-subscription',
  recommendedModels: [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-4-5-haiku',
  ],
  capabilities: ['streaming', 'tools', 'function-calling', 'vision'],
  supportsModelInstallation: false,
  supportsStreaming: true,

  agentHooks: {
    'claude': {
      async beforeRun(env) {
        // Native Claude subscription auth relies on Claude Code's stored login.
        // Any explicit token env var overrides that flow and causes 401s.
        delete env.ANTHROPIC_AUTH_TOKEN;
        delete env.ANTHROPIC_API_KEY;
        return env;
      }
    }
  },

  // Claude Code should use its own stored login/session instead of a placeholder token.
  exportEnvVars: (config) => {
    const env: Record<string, string> = {
      // transformEnvVars() runs before beforeRun(), and beforeRun() removes agent auth vars
      // for native Claude auth before the Claude process is spawned.
      CODEMIE_API_KEY: '',
    };

    if (config.codeMieUrl) {
      env.CODEMIE_URL = config.codeMieUrl;
      env.CODEMIE_SYNC_API_URL = ensureApiBase(config.codeMieUrl);
    }
    if (config.codeMieProject) {
      env.CODEMIE_PROJECT = config.codeMieProject;
    }

    return env;
  },

  setupInstructions: `
# Anthropic Subscription Setup Instructions

Use this option when Claude Code is already authenticated with your Anthropic account
and you want CodeMie to use that native login flow directly.

## Prerequisites

1. Install Claude Code
2. Authenticate Claude Code with your Anthropic subscription

\`\`\`bash
claude auth login
\`\`\`

## Notes

- No API key is stored in CodeMie for this provider
- Claude Code uses its existing local authentication/session
- This provider is intended for native \`codemie-claude\` usage
`
});
