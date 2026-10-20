import { logger } from '@/utils/logger.js';

/**
 * Once the backend rejects the current credentials, every further forward with the SAME
 * credential would fail identically, so forwarding is suspended until something changes.
 *
 * PR #655 (EPMCDME-15316) gave OtlpInterceptor's tick a throttled re-read of stored credentials
 * (CredentialRefresher, credential-refresh.ts) instead of a permanent daemon-startup snapshot —
 * so, unlike when this module was written, credentials CAN be refreshed in-process. The tick
 * calls `clearCredentialsStale()` whenever a refresh actually returns a different credential
 * object, letting the next forward attempt re-validate it; `markCredentialsStale` re-suspends
 * immediately if it is still rejected. A proxy restart remains a fallback path, not the only one.
 *
 * Deliberately in-memory: spool data keeps accumulating regardless, and is delivered either by
 * the next successful in-process forward or by the next proxy start.
 */
let credentialsStale = false;

export const areCredentialsStale = (): boolean => credentialsStale;

export function markCredentialsStale(): void {
  if (credentialsStale) return;
  credentialsStale = true;
  logger.warn(
    '[otlp] analytics credentials rejected — telemetry is being spooled to disk ' +
      'until a fresh credential is found or the proxy restarts'
  );
}

/** Called when a credential refresh picks up a different credential — see module header comment. */
export function clearCredentialsStale(): void {
  if (!credentialsStale) return;
  credentialsStale = false;
  logger.info('[otlp] a fresh credential was found — resuming telemetry forwarding');
}
