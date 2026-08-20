/**
 * FCC Provider - Halyk Bank Free Claude Code
 *
 * Provider template for Halyk Bank's internal Free Claude Code (FCC) setup.
 * FCC routes Claude Code requests through a corporate LiteLLM gateway with SSO authentication.
 */

import { registerProvider } from '../../core/decorators.js';
import type { ProviderTemplate } from '../../core/types.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';

/**
 * FCC Provider Template
 *
 * This provider is designed for Halyk Bank's corporate environment:
 * - Uses internal LiteLLM gateway (fcc-server-spmng.apps.spm3-dev-rz.halykbank.nb)
 * - Requires SSO authentication via session cookies
 * - Supports Claude models through corporate proxy
 * - Integrated with corporate analytics and audit logging
 */
export const FCC_PROVIDER: ProviderTemplate = {
  name: 'fcc',
  displayName: 'Halyk FCC (Free Claude Code)',
  description: 'Halyk Bank internal Claude Code via LiteLLM gateway with SSO',

  // Connectivity
  defaultBaseUrl: 'https://fcc-server-spmng.apps.spm3-dev-rz.halykbank.nb',
  requiresAuth: true,
  authType: 'sso',

  // UI & UX
  priority: 3, // High priority for corporate users
  defaultProfileName: 'halyk-fcc',
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