/**
 * SSO Provider Template
 *
 * Template definition for AI-Run SSO (CodeMie SSO) provider.
 * Enterprise SSO authentication with centralized model management.
 *
 * Auto-registers on import via registerProvider().
 */

import type { ProviderTemplate } from '../../core/types.js';
import { registerProvider } from '../../core/decorators.js';
import { createSSOLifecycleHandler } from './metrics/sync/sso.lifecycle-handler.js';
import { logger } from '../../../utils/logger.js';

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
    '*': {
      // Universal hooks for all agents when using SSO provider
      async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv): Promise<void> {
        // IMPORTANT:
        // - Use CODEMIE_URL for credential lookup (original SSO URL)
        // - Use CODEMIE_BASE_URL for API requests (proxy URL with cookie injection)
        const ssoUrl = env.CODEMIE_URL;
        const apiUrl = env.CODEMIE_BASE_URL;

        if (!ssoUrl || !apiUrl) {
          logger.info('[SSO] URLs not available for session metrics');
          return;
        }

        const handler = await createSSOLifecycleHandler(
          ssoUrl,
          apiUrl,
          env.CODEMIE_CLI_VERSION,
          'codemie-cli'
        );

        if (!handler) {
          logger.info('[SSO] Could not create lifecycle handler for session start');
          return;
        }

        // Store handler in env for later use
        (env as any).__SSO_LIFECYCLE_HANDLER = handler;

        logger.info('[SSO] Sending session start metric...');

        // Send session start metric (fire-and-forget, errors are logged but not thrown)
        await handler.sendSessionStart(
          {
            sessionId,
            agentName: env.CODEMIE_AGENT || 'unknown',
            provider: env.CODEMIE_PROVIDER || 'ai-run-sso',
            project: env.CODEMIE_PROJECT,
            llm_model: env.CODEMIE_MODEL,
            startTime: Date.now(),
            workingDirectory: process.cwd()
          },
          'started'
        );

        logger.info('[SSO] Session start metric processing complete (check logs for status)');
      },

      async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv): Promise<void> {
        const handler = (env as any).__SSO_LIFECYCLE_HANDLER;
        if (!handler) {
          logger.info('[SSO] No lifecycle handler available for session end');
          return;
        }

        logger.info(`[SSO] Sending session end metric (exitCode=${exitCode})...`);

        // Send session end metric (fire-and-forget, errors are logged but not thrown)
        await handler.sendSessionEnd(exitCode);

        logger.info('[SSO] Session end metric processing complete (check logs for status)');

        // Cleanup
        delete (env as any).__SSO_LIFECYCLE_HANDLER;
      }
    }
  }
});
