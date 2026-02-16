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
import { registerProvider } from '../../core/index.js';

export const JWTTemplate = registerProvider<ProviderTemplate>({
  name: 'bearer-auth',
  displayName: 'Bearer Authorization',
  description: 'JWT token authentication - Provide token via CLI or environment variable',
  defaultBaseUrl: 'https://codemie.lab.epam.com',
  requiresAuth: true,
  authType: 'jwt',
  priority: 1, // Show after CodeMie SSO
  defaultProfileName: 'jwt-bearer',
  recommendedModels: [
    'claude-4-5-sonnet',
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
