/**
 * Moonshot Subscription Provider Template
 *
 * Template definition for native Kimi Code authentication using
 * an existing Moonshot subscription login.
 *
 * Auto-registers on import via registerProvider().
 */

import type { ProviderTemplate } from '../../core/types.js';
import type { AgentConfig } from '../../../agents/core/types.js';
import { registerProvider } from '../../core/decorators.js';
import { ensureApiBase } from '../../core/codemie-auth-helpers.js';

export const MoonshotSubscriptionTemplate = registerProvider<ProviderTemplate>({
  name: 'moonshot-subscription',
  displayName: 'Moonshot Subscription',
  description: 'Native Kimi Code CLI authentication using your Moonshot subscription',
  defaultBaseUrl: 'https://api.moonshot.ai/v1',
  requiresAuth: false,
  authType: 'none',
  priority: 16,
  defaultProfileName: 'moonshot-subscription',
  recommendedModels: ['kimi-for-coding', 'kimi-k2'],
  capabilities: ['streaming', 'tools', 'function-calling', 'vision'],
  supportsModelInstallation: false,
  supportsStreaming: true,

  agentHooks: {
    '*': {
      async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig): Promise<NodeJS.ProcessEnv> {
        if (config.agent !== 'kimi') {
          return env;
        }

        // Return a copy so callers that hold a reference to the original env are not affected.
        const updated = { ...env };

        // Native Kimi subscription auth relies on Kimi Code's stored login in
        // ~/.kimi-code/config.toml. Explicit Moonshot API/proxy env vars override
        // that flow and can cause 401s.
        delete updated.KIMI_MODEL_API_KEY;
        delete updated.KIMI_MODEL_BASE_URL;
        delete updated.KIMI_MODEL_NAME;

        // Inject CodeMie lifecycle hooks into Kimi config so local metrics and
        // conversation files are produced even though model traffic is not
        // proxied through CodeMie.
        //
        // Dynamic import avoids a circular dependency: AgentRegistry imports all
        // plugins (including this provider template) as side effects, so a
        // static top-level import here would form a cycle. The dynamic import
        // defers resolution until runtime when the registry is fully initialised.
        try {
          const { AgentRegistry } = await import('../../../agents/registry.js');
          const { KimiHookConfigInjector } = await import('../../../agents/plugins/kimi/kimi.hook-config-injector.js');

          const agent = AgentRegistry.getAgent('kimi');
          if (!agent) {
            const { logger } = await import('../../../utils/logger.js');
            logger.warn('[moonshot-subscription] Kimi agent not found in registry; skipping hook injection');
            logger.warn('[moonshot-subscription] Continuing without hooks - metrics may not be captured');
            return updated;
          }

          const injector = new KimiHookConfigInjector();
          const result = await injector.inject();

          if (!result.success) {
            const { logger } = await import('../../../utils/logger.js');
            logger.warn(`[moonshot-subscription] Hook injection returned failure: ${result.error || 'unknown error'}`);
            logger.warn('[moonshot-subscription] Continuing without hooks - metrics may not be captured');
          }
        } catch (error) {
          const { logger } = await import('../../../utils/logger.js');
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error(`[moonshot-subscription] Hook injection threw exception: ${errorMsg}`);
          logger.warn('[moonshot-subscription] Continuing without hooks - metrics may not be captured');
        }

        return updated;
      }
    }
  },

  // Kimi Code should use its own stored login/session instead of a placeholder token.
  exportEnvVars: (config) => {
    const env: Record<string, string> = {
      CODEMIE_API_KEY: ''
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
# Moonshot Subscription Setup Instructions

Use this option when Kimi Code is already authenticated with your Moonshot account
and you want CodeMie to use that native login flow directly.

## Prerequisites

1. Install Kimi Code
2. Authenticate Kimi Code with your Moonshot subscription

\`\`\`bash
kimi auth login
\`\`\`

## Notes

- No API key is stored in CodeMie for this provider
- Kimi Code uses its existing local authentication/session from \`~/.kimi-code/config.toml\`
- CodeMie injects lifecycle hooks into Kimi config to capture metrics locally
- This provider is intended for native \`kimi\` usage
`
});
