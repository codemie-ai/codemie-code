import { logger } from '@/utils/logger.js';

/**
 * Credentials are captured once at proxy start and cannot be refreshed
 * in-process. Once the backend rejects them, every further forward would fail
 * identically, so forwarding is suspended for the rest of this process.
 *
 * Deliberately in-memory: spool data keeps accumulating and is delivered by the
 * next proxy start, which supplies fresh credentials.
 */
let credentialsStale = false;

export const areCredentialsStale = (): boolean => credentialsStale;

export function markCredentialsStale(): void {
  if (credentialsStale) return;
  credentialsStale = true;
  logger.warn(
    '[otlp] analytics credentials rejected — telemetry is being spooled to disk ' +
      'and will be delivered after a proxy restart'
  );
}
