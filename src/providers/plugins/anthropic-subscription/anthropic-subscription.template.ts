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
  // Display-only (setup wizard listing) — this provider never forces a model
  // choice onto the claude CLI; see exportEnvVars below. Family token, not a
  // pinned version — computeRecommendedModelIds (setup-ui.ts) matches it
  // against the live catalog and picks the current latest Sonnet. Only Sonnet
  // is starred as recommended; Opus/Haiku remain fully selectable.
  recommendedModels: ['sonnet'],
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

        // This provider has no CodeMie model catalog to resolve against (see
        // exportEnvVars below, which blanks CODEMIE_*_MODEL for the same reason), so
        // claude.plugin.ts deliberately skips catalog-based tier resolution entirely
        // for anthropic-subscription. That means nothing else ever clears these vars
        // for this provider - a stale value left over from a shell export, a previous
        // profile/run in the same session, or manual testing would otherwise silently
        // and permanently pin the launched claude CLI to an outdated model. Delete them
        // so the claude CLI always falls back to its own live-latest built-in defaults.
        delete updated.ANTHROPIC_DEFAULT_HAIKU_MODEL;
        delete updated.ANTHROPIC_DEFAULT_SONNET_MODEL;
        delete updated.ANTHROPIC_DEFAULT_OPUS_MODEL;
        delete updated.CLAUDE_CODE_SUBAGENT_MODEL;

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
        let result = args;

        // Carry the explicit CLI --model straight through to the claude binary.
        // Sourced from CODEMIE_CLI_MODEL (set by AgentCLI only when the user passed
        // -m/--model this launch) — never from the stored profile, so a pre-existing
        // profile's stale model is ignored. Claude Code owns entitlement/refusal.
        const cliModel = process.env.CODEMIE_CLI_MODEL;
        const hasModelFlag = result.some(arg => arg === '--model' || arg.startsWith('--model='));
        if (cliModel && !hasModelFlag) {
          result = ['--model', cliModel, ...result];
        }

        const pluginDir = process.env.CODEMIE_CLAUDE_EXTENSION_DIR;
        if (pluginDir && !result.some(arg => arg === '--plugin-dir')) {
          result = ['--plugin-dir', pluginDir, ...result];
        }

        return result;
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

    // SSO/JWT use CodeMie gateway model names, but this provider talks directly to
    // Anthropic via Claude Code's native subscription session — there is no CodeMie
    // catalog to resolve a model from here, so defer entirely to the claude CLI's
    // own built-in defaults instead of forcing a (potentially stale) hardcoded one.
    //
    // ConfigLoader.exportProviderEnvVars() sets CODEMIE_MODEL from config.model
    // *before* layering this provider's exportEnvVars on top, so these must be
    // explicitly blanked here — omitting them would leave the profile's saved
    // (possibly stale) model in place.
    env.CODEMIE_MODEL = '';
    env.CODEMIE_HAIKU_MODEL = '';
    env.CODEMIE_SONNET_MODEL = '';
    env.CODEMIE_OPUS_MODEL = '';

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
