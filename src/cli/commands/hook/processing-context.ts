import type { ProcessingContext } from '@/agents/core/session/BaseProcessor.js';
import type { CredentialsSupersededCheck } from '@/providers/plugins/sso/session/cookie-auth.js';
import type { HookProcessingConfig } from '../hook.js';
import { loadAnalyticsCookies } from './analytics-cookies.js';
import { configSendPathApiUrl, getConfigValue } from './config-value.js';

/**
 * Build processing context for SessionAdapter
 * @param sessionId - CodeMie session ID
 * @param agentSessionId - Agent session ID
 * @param agentSessionFile - Path to agent session file
 * @param config - Optional configuration object (if not provided, reads from environment variables)
 * @returns Processing context for SessionAdapter
 */
export async function buildProcessingContext(
  sessionId: string,
  agentSessionId: string,
  agentSessionFile: string,
  config?: HookProcessingConfig
): Promise<ProcessingContext> {
  // Get configuration values from config object or environment variables
  const ssoUrl = getConfigValue('CODEMIE_URL', config);
  const apiKey = config?.apiKey || getConfigValue('CODEMIE_API_KEY', config);
  // An API key replaces the SSO cookies on every request, so its URL needs no send path
  const apiUrl = (apiKey
    ? getConfigValue('CODEMIE_SYNC_API_URL', config) || getConfigValue('CODEMIE_BASE_URL', config)
    : configSendPathApiUrl(config)) || '';
  const cliVersion = getConfigValue('CODEMIE_CLI_VERSION', config) || '0.0.0';
  const clientType = getConfigValue('CODEMIE_CLIENT_TYPE', config) || 'codemie-cli';

  // Load the CodeMie session metadata so processors can use gitBranch and other
  // session-level fields that are not present in the native agent transcript.
  let gitBranch: string | undefined;
  try {
    const { getCodemiePath } = await import('../../../utils/paths.js');
    const { readFile } = await import('node:fs/promises');
    const sessionMeta = JSON.parse(
      await readFile(getCodemiePath('sessions', `${sessionId}.json`), 'utf-8')
    ) as { gitBranch?: string };
    gitBranch = sessionMeta.gitBranch;
  } catch {
    // Session metadata may not exist in all contexts (e.g., tests); proceed without it.
  }

  // Build context with SSO credentials if available
  let cookies = config?.cookies || '';
  let authorization = config?.authorization;
  let credentialsSuperseded: CredentialsSupersededCheck | undefined;

  // If CodeMie analytics auth is configured and credentials are not provided,
  // try to load the stored SSO cookies/authorization. This also supports native providers
  // such as anthropic-subscription, where CodeMie auth is analytics-only.
  if (ssoUrl && apiUrl && !cookies && !authorization) {
    ({ cookies, authorization, credentialsSuperseded } = await loadAnalyticsCookies('[hook]', ssoUrl, config));
  }

  return {
    apiBaseUrl: apiUrl,
    cookies,
    authorization,
    apiKey,
    ...(!apiKey && credentialsSuperseded && { credentialsSuperseded }),
    clientType,
    version: cliVersion,
    dryRun: false,
    sessionId,
    agentSessionId,
    agentSessionFile,
    gitBranch,
  };
}
