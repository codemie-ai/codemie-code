/**
 * Shared throttled re-reader of stored SSO credentials.
 *
 * PR #655 (EPMCDME-15316) fixed the LLM-request path (SSOAuthInterceptor) to re-read credentials
 * from disk instead of injecting the daemon-startup snapshot forever, so a successful browser
 * re-login takes effect without restarting the proxy. Every OTHER proxied-request consumer kept
 * its own independent startup snapshot (session/metrics sync, OTLP telemetry forwarding, the
 * Claude/Codex model-catalogue fetch) — a re-login never reached any of them, so a stale sync
 * kept getting rejected, re-marking the shared analytics-auth-status invalid and re-opening the
 * browser in a loop (PR #655 review, blocking). This module is the one throttled refresher every
 * one of those consumers now shares, so there is exactly one place this logic can drift.
 *
 * JWT credentials are a static API key, not something a browser re-login rotates — `refresh()`
 * is a no-op for them (returns the same object every time).
 */
import { getStoredPlatformCredentials } from '../../../../core/codemie-auth-helpers.js';
import type { SSOCredentials, JWTCredentials } from '../../../../core/types.js';
import { logger } from '../../../../../utils/logger.js';

/** Minimum time between stored-credential re-reads — see the class doc comment for why a flat
 * time window rather than gating on the credential's own `expiresAt`. */
export const CREDENTIAL_REFRESH_INTERVAL_MS = 5000;

export interface CredentialRefreshParams {
  provider?: string;
  baseUrl: string;
  codeMieUrl?: string;
}

export class CredentialRefresher<T extends SSOCredentials | JWTCredentials> {
  private current: T;
  private lastRefreshedAt = 0;

  constructor(initialCredentials: T, private readonly params: CredentialRefreshParams) {
    this.current = initialCredentials;
  }

  /** Last known-good credentials — the daemon-startup snapshot until the first successful refresh. */
  get(): T {
    return this.current;
  }

  /**
   * Throttles the disk/keychain re-read to once per `CREDENTIAL_REFRESH_INTERVAL_MS`, rather than
   * once per call: a long multi-turn session, a periodic sync tick, or an OTLP forward tick would
   * otherwise pay an OS-keychain IPC call plus a file read/decrypt every time.
   *
   * Deliberately NOT gated on the credential's own `expiresAt` being in the future:
   * SSOSessionExpiryPlugin (sso-session-expiry.plugin.ts) acts on the oauth2-proxy redirect
   * signature ALONE, because a server-side session revoke does not change the local JWT's own
   * `exp` claim — that plugin's own header comment calls this out as the primary real-world
   * trigger. An `expiresAt`-based skip would treat a revoked-but-not-yet-expired credential as
   * "fresh" forever and never pick up the fresh cookies a revoke-triggered re-login writes to
   * disk, reopening the very "stuck until daemon restart" bug this class exists to fix. The flat
   * TTL is safe against that same scenario because a real browser re-login takes far longer than
   * `CREDENTIAL_REFRESH_INTERVAL_MS` to complete, so by the time it does, the next call here is
   * guaranteed to re-read.
   */
  async refresh(): Promise<T> {
    if (!('cookies' in this.current)) {
      return this.current; // JWT — static, nothing to refresh
    }
    if (Date.now() - this.lastRefreshedAt < CREDENTIAL_REFRESH_INTERVAL_MS) {
      return this.current;
    }
    this.lastRefreshedAt = Date.now();
    try {
      const stored = await getStoredPlatformCredentials(this.params);
      if (stored?.credentials) {
        this.current = stored.credentials as T;
      }
      // No fresher credentials found yet: keep using the last known-good ones.
    } catch (error) {
      logger.debug('[credential-refresh] Failed to re-read stored SSO credentials; using the last known-good snapshot', error);
    }
    return this.current;
  }
}
