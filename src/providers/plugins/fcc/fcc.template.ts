

import { registerProvider } from '../../core/decorators.js';
import type { ProviderTemplate } from '../../core/types.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';


export const FCC_PROVIDER: ProviderTemplate = {
  name: 'fcc',
  displayName: 'FCC (LiteLLM Gateway)',
  description: 'Claude Code via LiteLLM gateway with custom authentication',

  defaultBaseUrl: '',
  requiresAuth: true,
  authType: 'sso',


  priority: 3,
  defaultProfileName: 'fcc',
  recommendedModels: ['claude-sonnet-4-5-20250929', 'claude-opus-4-5-20250929'],

    capabilities: ['streaming', 'tools', 'sso-auth'],
  supportsModelInstallation: false,
  supportsStreaming: true,

  
  exportEnvVars: (config: CodeMieConfigOptions) => {
    const env: Record<string, string> = {};

    const fccLiteLLMKey = (config as any).fccLiteLLMKey;
    const fccServerUrl = (config as any).fccServerUrl;

    if (fccLiteLLMKey) {
      env.CODEMIE_FCC_LITELLM_KEY = fccLiteLLMKey;
    }
    if (fccServerUrl) {
      env.CODEMIE_FCC_SERVER_URL = fccServerUrl;
    }

    if (config.apiKey) {
      env.ANTHROPIC_AUTH_TOKEN = config.apiKey;
    }

    return env;
  }
};

export const FCCProvider = registerProvider(FCC_PROVIDER);