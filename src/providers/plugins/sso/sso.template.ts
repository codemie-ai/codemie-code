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
  recommendedModels: [
    'claude-4-5-sonnet',
  ],
  capabilities: ['streaming', 'tools', 'sso-auth', 'function-calling', 'embeddings'],
  supportsModelInstallation: false,
  supportsStreaming: true,
  customProperties: {
    requiresIntegration: true,
    sessionDuration: 86400000 // 24 hours
  }
});
