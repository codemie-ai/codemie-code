/**
 * SSO Provider Template
 *
 * Template definition for AI-Run SSO (CodeMie SSO) provider.
 * Enterprise SSO authentication with centralized model management.
 *
 * Auto-registers on import via registerProvider().
 */

import type { ProviderTemplate } from '../../core/types.js';
import { registerProvider } from '../../core/index.js';
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
    },

    // Claude-specific hooks for plugin installation
    'claude': {
      /**
       * Install Claude plugin before running agent
       * Only applies when using ai-run-sso provider
       */
      async beforeRun(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
        const { ClaudePluginInstaller } = await import('../../../agents/plugins/claude/claude.plugin-installer.js');

        logger.info('[SSO-Claude] Checking CodeMie plugin for Claude Code...');

        const result = await ClaudePluginInstaller.install();

        if (!result.success) {
          logger.error(`[SSO-Claude] Plugin installation failed: ${result.error}`);
          logger.warn('[SSO-Claude] Continuing without plugin - hooks will not be available');
        } else if (result.action === 'copied') {
          const versionInfo = result.sourceVersion ? ` (v${result.sourceVersion})` : '';
          logger.info(`[SSO-Claude] Plugin installed to ${result.targetPath}${versionInfo}`);
        } else if (result.action === 'updated') {
          const versionInfo = result.installedVersion && result.sourceVersion
            ? ` (v${result.installedVersion} → v${result.sourceVersion})`
            : '';
          logger.info(`[SSO-Claude] Plugin updated at ${result.targetPath}${versionInfo}`);
        } else {
          const versionInfo = result.sourceVersion ? ` (v${result.sourceVersion})` : '';
          logger.debug(`[SSO-Claude] Plugin already up-to-date at ${result.targetPath}${versionInfo}`);
        }

        // Store target path in env for enrichArgs hook
        env.CODEMIE_CLAUDE_PLUGIN_DIR = result.targetPath;

        return env;
      },

      /**
       * Inject --plugin-dir flag for Claude Code
       * Only applies when using ai-run-sso provider
       *
       * Note: enrichArgs is synchronous, so we read the plugin path
       * from process.env that was set by beforeRun hook
       */
      enrichArgs(args: string[]): string[] {
        // Get plugin directory from env (set by beforeRun)
        const pluginDir = process.env.CODEMIE_CLAUDE_PLUGIN_DIR;

        if (!pluginDir) {
          logger.warn('[SSO-Claude] Plugin directory not found in env, skipping --plugin-dir injection');
          return args;
        }

        // Check if --plugin-dir already specified
        const hasPluginDir = args.some(arg => arg === '--plugin-dir');

        if (hasPluginDir) {
          logger.debug('[SSO-Claude] --plugin-dir already specified, skipping injection');
          return args;
        }

        logger.info(`[SSO-Claude] Injecting --plugin-dir ${pluginDir}`);

        // Prepend --plugin-dir to arguments
        return ['--plugin-dir', pluginDir, ...args];
      }
    }
  }
});
