/**
 * SSO Provider Template
 *
 * Template definition for AI-Run SSO (CodeMie SSO) provider.
 * Enterprise SSO authentication with centralized model management.
 *
 * Auto-registers on import via registerProvider().
 */

import type { ProviderTemplate } from '../../core/types.js';
import type { AgentConfig } from '../../../agents/core/types.js';
import { registerProvider } from '../../core/index.js';

export const SSOTemplate = registerProvider<ProviderTemplate>({
  name: 'ai-run-sso',
  displayName: 'CodeMie SSO',
  description: 'Enterprise SSO Authentication with centralized model management',
  defaultBaseUrl: 'https://codemie.lab.epam.com', // Default CodeMie URL
  requiresAuth: true,
  authType: 'sso',
  priority: 0, // Highest priority (shown first)
  defaultProfileName: 'codemie-sso',
  recommendedModels: [
    'claude-4-5-sonnet',
    'gpt-5-1-codex',
  ],
  capabilities: ['streaming', 'tools', 'sso-auth', 'function-calling', 'embeddings'],
  supportsModelInstallation: false,
  supportsStreaming: true,
  customProperties: {
    requiresIntegration: true,
    sessionDuration: 86400000 // 24 hours
  },

  // Environment Variable Export
  exportEnvVars: (config) => {
    const env: Record<string, string> = {};

    // SSO-specific environment variables
    if (config.codeMieUrl) env.CODEMIE_URL = config.codeMieUrl;
    if (config.codeMieProject) env.CODEMIE_PROJECT = config.codeMieProject;
    if (config.authMethod) env.CODEMIE_AUTH_METHOD = config.authMethod;

    // Only export integration ID if integration is configured
    if (config.codeMieIntegration?.id) {
      env.CODEMIE_INTEGRATION_ID = config.codeMieIntegration.id;
    }

    return env;
  },

  // Agent lifecycle hooks for session metrics
  agentHooks: {
    /**
     * Wildcard hook for ALL agents - generic extension installation
     * Checks if agent has getExtensionInstaller() method
     * Installer handles all logging internally
     *
     * Correct signature: (env, config) - matches lifecycle-helpers.ts
     * Agent name is available in config.agent (not as third parameter)
     */
    '*': {
      async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig): Promise<NodeJS.ProcessEnv> {
        // Get agent name from config (not from third parameter)
        const agentName = config.agent;
        if (!agentName) {
          return env; // No agent name, skip silently
        }

        // Dynamic import to avoid circular dependency
        // AgentRegistry imports all plugins, which would cause circular dependency
        // if imported at module level (SSO template is loaded as side effect)
        const { AgentRegistry } = await import('../../../agents/registry.js');

        // Get agent from registry
        const agent = AgentRegistry.getAgent(agentName);
        if (!agent) {
          return env; // Agent not found, skip silently
        }

        // Check if agent has extension installer
        const installer = (agent as any).getExtensionInstaller?.();
        if (!installer) {
          return env; // No installer, skip silently
        }

        // Run installer with error handling (logging happens INSIDE installer)
        try {
          const result = await installer.install();

          // Store target path in env (for enrichArgs if needed)
          env[`CODEMIE_${agentName.toUpperCase()}_EXTENSION_DIR`] = result.targetPath;

          if (!result.success) {
            // Installation failed but returned a result
            const { logger } = await import('../../../utils/logger.js');
            logger.warn(`[${agentName}] Extension installation returned failure: ${result.error || 'unknown error'}`);
            logger.warn(`[${agentName}] Continuing without extension - hooks may not be available`);
          }
        } catch (error) {
          // Installation threw an exception
          const { logger } = await import('../../../utils/logger.js');
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error(`[${agentName}] Extension installation threw exception: ${errorMsg}`);
          logger.warn(`[${agentName}] Continuing without extension - hooks may not be available`);
          // Don't throw - continue agent startup even if extension fails
        }

        return env;
      }
    },

    // Claude-specific: inject --plugin-dir flag
    'claude': {
      /**
       * Inject --plugin-dir flag for Claude Code
       * Only applies when using ai-run-sso provider
       *
       * Note: enrichArgs is synchronous, so we read the plugin path
       * from process.env that was set by beforeRun hook
       */
      enrichArgs(args: string[], _config: AgentConfig): string[] {
        // Get plugin directory from env (set by beforeRun)
        const pluginDir = process.env.CODEMIE_CLAUDE_EXTENSION_DIR;

        if (!pluginDir) {
          return args;
        }

        // Check if --plugin-dir already specified
        const hasPluginDir = args.some(arg => arg === '--plugin-dir');

        if (hasPluginDir) {
          return args;
        }

        // Prepend --plugin-dir to arguments
        return ['--plugin-dir', pluginDir, ...args];
      }
    }
  }
});
