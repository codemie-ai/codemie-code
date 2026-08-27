/**
 * FCC Provider
 *
 * Provider template for FCC setup.
 * FCC routes requests through a corporate LiteLLM gateway with SSO authentication.
 */

import { registerProvider } from '../../core/decorators.js';
import type { ProviderTemplate } from '../../core/types.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';

/**
 * FCC Provider Template
 *
 * This provider is designed for  environments:
 * - Uses internal LiteLLM gateway
 * - Requires SSO authentication via session cookies
 * - Supports Claude models through corporate proxy
 */
export const FCC_PROVIDER: ProviderTemplate = {
  name: 'fcc',
  displayName: 'FCC (Free Claude Code)',
  description: 'Corporate Claude Code via LiteLLM gateway with SSO',

  // Connectivity
  defaultBaseUrl: '',
  requiresAuth: true,
  authType: 'sso',

  // UI & UX
  priority: 3,
  defaultProfileName: 'fcc',
  recommendedModels: ['claude-sonnet-4-5-20250929', 'claude-opus-4-5-20250929'],

  // Capabilities
  capabilities: ['streaming', 'tools', 'sso-auth'],
  supportsModelInstallation: false,
  supportsStreaming: true,

  // Environment Variable Export
  exportEnvVars: (config: CodeMieConfigOptions) => {
    const env: Record<string, string> = {};

    // FCC-specific environment variables
    const fccLiteLLMKey = (config as any).fccLiteLLMKey;
    const fccServerUrl = (config as any).fccServerUrl;

    if (fccLiteLLMKey) {
      env.CODEMIE_FCC_LITELLM_KEY = fccLiteLLMKey;
    }
    if (fccServerUrl) {
      env.CODEMIE_FCC_SERVER_URL = fccServerUrl;
    }

    // Use apiKey as auth token for FCC
    if (config.apiKey) {
      env.ANTHROPIC_AUTH_TOKEN = config.apiKey;
    }

    return env;
  }
};

// Auto-register with ProviderRegistry on import
export const FCCProvider = registerProvider(FCC_PROVIDER);