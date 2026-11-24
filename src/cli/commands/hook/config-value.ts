import type { HookProcessingConfig } from '../hook.js';
import { sendPathApiUrl } from '@/agents/core/session/send-path.js';

/**
 * Helper function to get configuration value from config object or environment variable
 * @param envKey - Environment variable key (e.g., 'CODEMIE_AGENT')
 * @param config - Optional config object
 * @returns Configuration value or undefined
 */
export function getConfigValue(envKey: string, config?: HookProcessingConfig): string | undefined {
  if (config) {
    // Map environment variable keys to config properties
    const configMap: Record<string, keyof HookProcessingConfig> = {
      'CODEMIE_AGENT': 'agentName',
      'CODEMIE_PROVIDER': 'provider',
      'CODEMIE_BASE_URL': 'apiBaseUrl',
      'CODEMIE_API_KEY': 'apiKey',
      'CODEMIE_CLIENT_TYPE': 'clientType',
      'CODEMIE_CLI_VERSION': 'version',
      'CODEMIE_PROFILE_NAME': 'profileName',
      'CODEMIE_PROJECT': 'project',
      'CODEMIE_MODEL': 'model',
      'CODEMIE_URL': 'ssoUrl',
      'CODEMIE_SYNC_API_URL': 'syncApiUrl',
    };
    const configKey = configMap[envKey];
    if (configKey) {
      return config[configKey] as string | undefined;
    }
  }
  return process.env[envKey];
}

/** Whether the sync of pending data applies to this launch (CodeMie analytics auth configured). */
export function syncApplies(config?: HookProcessingConfig): boolean {
  const provider = getConfigValue('CODEMIE_PROVIDER', config);
  const ssoUrl = getConfigValue('CODEMIE_URL', config);
  const syncApiUrl = getConfigValue('CODEMIE_SYNC_API_URL', config);
  return provider === 'ai-run-sso' || Boolean(ssoUrl && syncApiUrl);
}

/** The API a request with SSO credentials goes to: the launch's send path, else undefined. */
export function configSendPathApiUrl(config?: HookProcessingConfig): string | undefined {
  return sendPathApiUrl({
    CODEMIE_URL: getConfigValue('CODEMIE_URL', config),
    CODEMIE_SYNC_API_URL: getConfigValue('CODEMIE_SYNC_API_URL', config),
    CODEMIE_BASE_URL: getConfigValue('CODEMIE_BASE_URL', config),
    CODEMIE_TARGET_API_URL: (config?.env ?? process.env).CODEMIE_TARGET_API_URL,
  });
}
