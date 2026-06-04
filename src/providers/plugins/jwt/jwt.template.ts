/**
 * JWT Bearer Authorization Provider Template
 *
 * Template definition for JWT token authentication.
 * Users provide only the API URL during setup - JWT token is provided later
 * via --jwt-token CLI option or CODEMIE_JWT_TOKEN environment variable.
 *
 * Auto-registers on import via registerProvider().
 */

import type { ProviderTemplate } from '../../core/types.js';
import type { AgentConfig } from '../../../agents/core/types.js';
import { registerProvider } from '../../core/index.js';

export const JWTTemplate = registerProvider<ProviderTemplate>({
  name: 'bearer-auth',
  displayName: 'Bearer Authorization',
  description: 'JWT token authentication - Provide token via CLI or environment variable',
  defaultBaseUrl: 'https://codemie.lab.epam.com',
  requiresAuth: true,
  authType: 'jwt',
  priority: 1, // Show after CodeMie SSO
  hidden: true, // Not shown in interactive setup - used only for script/auto-configuration
  defaultProfileName: 'jwt-bearer',
  recommendedModels: [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'gpt-4-turbo',
  ],
  capabilities: ['streaming', 'tools', 'function-calling'],
  supportsModelInstallation: false,
  supportsStreaming: true,
  customProperties: {
    requiresToken: true,
    tokenSource: 'runtime' // Token provided at runtime, not during setup
  },

  // Agent lifecycle hooks — install extension and inject --plugin-dir (mirrors SSO template)
  agentHooks: {
    '*': {
      async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig): Promise<NodeJS.ProcessEnv> {
        const agentName = config.agent;
        if (!agentName) return env;

        const { AgentRegistry } = await import('../../../agents/registry.js');
        const agent = AgentRegistry.getAgent(agentName);
        if (!agent) return env;

        const installer = (agent as any).getExtensionInstaller?.();
        if (!installer) return env;

        try {
          const result = await installer.install();
          env[`CODEMIE_${agentName.toUpperCase()}_EXTENSION_DIR`] = result.targetPath;
          if (!result.success) {
            const { logger } = await import('../../../utils/logger.js');
            logger.warn(`[${agentName}] Extension installation returned failure: ${result.error || 'unknown error'}`);
          }
        } catch (error) {
          const { logger } = await import('../../../utils/logger.js');
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.warn(`[${agentName}] Extension installation failed: ${errorMsg}`);
        }

        return env;
      }
    },

    'claude': {
      enrichArgs(args: string[], _config: AgentConfig): string[] {
        const pluginDir = process.env.CODEMIE_CLAUDE_EXTENSION_DIR;
        if (!pluginDir) return args;
        if (args.some(arg => arg === '--plugin-dir')) return args;
        return ['--plugin-dir', pluginDir, ...args];
      }
    }
  },

  // Environment Variable Export
  exportEnvVars: (config) => {
    const env: Record<string, string> = {};

    // Export base URL (user's input) - matches SSO pattern
    if (config.codeMieUrl) {
      env.CODEMIE_URL = config.codeMieUrl;
    }

    // Set auth method to JWT
    env.CODEMIE_AUTH_METHOD = 'jwt';

    // Export JWT token if available (from env var or config)
    const tokenEnvVar = config.jwtConfig?.tokenEnvVar || 'CODEMIE_JWT_TOKEN';
    const token = process.env[tokenEnvVar] || config.jwtConfig?.token;
    if (token) {
      env.CODEMIE_JWT_TOKEN = token;
    }

    // Export project info if available
    if (config.codeMieProject) {
      env.CODEMIE_PROJECT = config.codeMieProject;
    }

    return env;
  }
});
