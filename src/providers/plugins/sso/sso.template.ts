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

export const SSOTemplate = registerProvider<ProviderTemplate>({
  name: 'ai-run-sso',
  displayName: 'CodeMie SSO',
  description: 'Enterprise SSO Authentication with centralized model management',
  defaultBaseUrl: 'https://codemie.lab.epam.com', // Default CodeMie URL
  requiresAuth: true,
  authType: 'sso',
  priority: 0, // Highest priority (shown first)
  defaultProfileName: 'codemie-sso',

  supportedAgents: ['*'], // Supports all agents

  // Recommended models for UI hints (⭐ stars and sorting)
  recommendedModels: [
    'claude-4-5-sonnet'
  ],

  supportsModelInstallation: false,

  envExport: (providerConfig) => {
    const env: Record<string, string> = {};

    // SSO-specific environment variables only
    if (providerConfig.codeMieUrl) env.CODEMIE_URL = String(providerConfig.codeMieUrl);
    if (providerConfig.codeMieProject) env.CODEMIE_PROJECT = String(providerConfig.codeMieProject);
    if (providerConfig.authMethod) env.CODEMIE_AUTH_METHOD = String(providerConfig.authMethod);

    // Integration ID
    if (providerConfig.codeMieIntegration) {
      const integration = providerConfig.codeMieIntegration as { id?: string };
      if (integration.id) env.CODEMIE_INTEGRATION_ID = integration.id;
    }

    // SSO session config
    if (providerConfig.ssoConfig) {
      const ssoConfig = providerConfig.ssoConfig as Record<string, unknown>;
      if (ssoConfig.apiUrl) env.CODEMIE_API_URL = String(ssoConfig.apiUrl);
    }

    return env;
  },

  customProperties: {
    requiresIntegration: true,
    sessionDuration: 86400000 // 24 hours
  }
});
