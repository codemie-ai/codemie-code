import { logger } from '@/utils/logger.js';
import type { JWTCredentials, SSOCredentials } from '../../../../../core/types.js';
import type { ProxyConfig } from '../../proxy-types.js';
import { getStoredPlatformCredentials } from '../../../../../core/codemie-auth-helpers.js';

/**
 * Once the backend rejects the in-memory credentials, every further forward would
 * fail identically, so forwarding is suspended until this flag is cleared.
 *
 * `OtlpInterceptor` re-reads the credential store whenever this is set — on its
 * own tick and opportunistically on inbound OTLP traffic — and clears it when a
 * fresh read succeeds. This lets a user's SSO re-login resume delivery without a
 * proxy restart. Spool data keeps accumulating on disk while stale, so nothing is
 * lost in the meantime.
 */
let credentialsStale = false;

export const areCredentialsStale = (): boolean => credentialsStale;

export function markCredentialsStale(): void {
  if (credentialsStale) return;
  credentialsStale = true;
  logger.warn(
    '[otlp] analytics credentials rejected — telemetry is being spooled to disk ' +
      'until a credential refresh (automatic) or a proxy restart (manual) resumes delivery'
  );
}

/** Called once a fresh credential read succeeds; resumes forwarding. */
export function clearCredentialsStale(): void {
  if (!credentialsStale) return;
  credentialsStale = false;
  logger.info('[otlp] analytics credentials refreshed — resuming telemetry delivery');
}

/**
 * Re-resolves credentials from the credential store using the same priority as
 * `CodeMieProxy.start()`: sync credentials first, then platform credentials.
 */
export async function resolveFreshCredentials(
  config: ProxyConfig
): Promise<SSOCredentials | JWTCredentials | null> {
  if (config.syncCodeMieUrl) {
    // Load the SSO implementation only when recovery needs its analytics credentials.
    const { CodeMieSSO } = await import('../../../sso.auth.js');
    const syncCredentials = await new CodeMieSSO().getStoredCredentials(config.syncCodeMieUrl);
    if (syncCredentials) {
      return syncCredentials;
    }
  }

  const stored = await getStoredPlatformCredentials({
    provider: config.provider,
    baseUrl: config.targetApiUrl,
    codeMieUrl: config.syncCodeMieUrl,
  });
  return stored?.credentials ?? null;
}
