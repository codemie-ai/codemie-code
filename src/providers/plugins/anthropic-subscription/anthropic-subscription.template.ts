/**
 * Anthropic Subscription Provider Template
 *
 * Template definition for native Claude Code authentication using
 * an existing Anthropic subscription login.
 *
 * Auto-registers on import via registerProvider().
 */

import type { ProviderTemplate } from '../../core/types.js';
import type { AgentConfig } from '../../../agents/core/types.js';
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
    '*': {
      async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig): Promise<NodeJS.ProcessEnv> {
        if (config.agent !== 'claude') {
          return env;
        }

        // Return a copy so callers that hold a reference to the original env are not affected.
        const updated = { ...env };

        // Native Claude subscription auth relies on Claude Code's stored login.
        // Explicit Anthropic API/proxy env vars override that flow and can cause 401s.
        delete updated.ANTHROPIC_AUTH_TOKEN;
        delete updated.ANTHROPIC_API_KEY;
        delete updated.ANTHROPIC_BASE_URL;

        // Reuse the Claude Code plugin hooks so local metrics/conversation files are
        // produced even though model traffic is not proxied through CodeMie.
        //
        // Dynamic import avoids a circular dependency: AgentRegistry imports all plugins
        // (including this provider template) as side effects, so a static top-level import
        // here would form a cycle.  The dynamic import defers resolution until runtime when
        // the registry is already fully initialised.
        try {
          const { AgentRegistry } = await import('../../../agents/registry.js');
          const agent = AgentRegistry.getAgent('claude');
          const installer = agent?.getExtensionInstaller?.();

          if (installer) {
            const result = await installer.install();
            updated.CODEMIE_CLAUDE_EXTENSION_DIR = result.targetPath;

            if (!result.success) {
              const { logger } = await import('../../../utils/logger.js');
              logger.warn(`[claude] Extension installation returned failure: ${result.error || 'unknown error'}`);
              logger.warn('[claude] Continuing without extension - hooks may not be available');
            }
          }
        } catch (error) {
          const { logger } = await import('../../../utils/logger.js');
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error(`[claude] Extension installation threw exception: ${errorMsg}`);
          logger.warn('[claude] Continuing without extension - hooks may not be available');
        }

        return updated;
      }
    },
    'claude': {
      enrichArgs(args: string[], _config: AgentConfig): string[] {
        const pluginDir = process.env.CODEMIE_CLAUDE_EXTENSION_DIR;

        if (!pluginDir || args.some(arg => arg === '--plugin-dir')) {
          return args;
        }

        return ['--plugin-dir', pluginDir, ...args];
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
