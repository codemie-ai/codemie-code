/**
 * SSO Provider Template
 *
 * Template definition for AI-Run SSO (CodeMie SSO) provider.
 * Enterprise SSO authentication with centralized model management.
 *
 * Auto-registers on import via registerProvider().
 */

import type { ProviderTemplate } from '../../core/types.js';
import { AuthMethod } from '../../core/types.js';
import { registerProvider } from '../../core/index.js';
import { defaultAgentHooks } from '../../core/default-agent-hooks.js';
import { DEFAULT_CODEMIE_BASE_URL } from '../../core/codemie-auth-helpers.js';
import { resolveJwtToken } from '../jwt/jwt.utils.js';

export const SSOTemplate = registerProvider<ProviderTemplate>({
  name: 'ai-run-sso',
  displayName: 'CodeMie SSO',
  description: 'Enterprise SSO Authentication with centralized model management',
  defaultBaseUrl: DEFAULT_CODEMIE_BASE_URL,
  requiresAuth: true,
  authType: 'sso',
  priority: 0, // Highest priority (shown first)
  defaultProfileName: 'codemie-sso',
  recommendedModels: [
    'claude-sonnet-4-6',
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

    // Export JWT token when auth method is JWT
    if (config.authMethod === AuthMethod.JWT) {
      const token = resolveJwtToken(config);
      if (token) env.CODEMIE_JWT_TOKEN = token;
    }

    // Only export integration ID if integration is configured
    if (config.codeMieIntegration?.id) {
      env.CODEMIE_INTEGRATION_ID = config.codeMieIntegration.id;
    }

    return env;
  },

  agentHooks: defaultAgentHooks
});
