/**
 * Shared throttled re-reader of stored SSO credentials.
 *
 * PR #655 (EPMCDME-15316) fixed the LLM-request path (SSOAuthInterceptor) to re-read credentials
 * from disk instead of injecting the daemon-startup snapshot forever, so a successful browser
 * re-login takes effect without restarting the proxy. Every OTHER proxied-request consumer kept
 * its own independent startup snapshot (session/metrics sync, the Claude/Codex model-catalogue
 * fetch) — a re-login never reached any of them, so a stale sync kept getting rejected,
 * re-marking the shared analytics-auth-status invalid and re-opening the browser in a loop (PR
 * #655 review, blocking). One shared instance of this class (built once in sso.proxy.ts, passed
 * via `PluginContext.credentialRefresher`) now backs every one of those consumers, so there is
 * exactly one cache/throttle clock, and exactly one place this logic can drift.
 *
 * OTLP telemetry forwarding is the one consumer NOT wired to this class: it already had its own
 * resume-after-re-auth path (`markCredentialsStale`/`resolveFreshCredentials`/
 * `clearCredentialsStale` in `otlp-spool/auth-state.ts`) from before this fix, gated on an
 * observed 401/403 rather than throttled on every call. Left as-is rather than merged into this
 * one, since OTLP forwarding runs on its own tick independent of the request path this class
 * was built for.
 *
 * JWT credentials are a static API key, not something a browser re-login rotates — `refresh()`
 * is a no-op for them (returns the same object every time).
 */
import { getStoredPlatformCredentials } from '../../../../core/codemie-auth-helpers.js';
import type { SSOCredentials, JWTCredentials } from '../../../../core/types.js';
import { logger } from '../../../../../utils/logger.js';
import { getAnalyticsAuthStatus } from '../../../../../utils/analytics-auth-status.js';

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
  private sawAuthInvalid = false;

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
   * disk, reopening the very "stuck until daemon restart" bug this class exists to fix.
   *
   * The flat TTL alone is NOT enough to guarantee the next call re-reads: the window is counted
   * from the last read, not from when a re-login finishes, so a login that completes partway
   * through the window still leaves stale cookies in `current` for whatever is left of it. To
   * close that gap, every call also cheaply checks the shared analytics-auth-status marker
   * (`markAnalyticsAuthInvalid`/`clearAnalyticsAuthStatus`, written across processes by
   * `sso-session-expiry.plugin.ts` and the login flow in `sso.auth.ts`): once that marker is seen
   * invalid and then clears, the credential store only changes at that same moment (a successful
   * login is the only thing that clears it), so the very next call here bypasses the throttle and
   * re-reads unconditionally, picking up the fresh cookies without waiting out the rest of the TTL.
   */
  async refresh(): Promise<T> {
    if (!('cookies' in this.current)) {
      return this.current; // JWT — static, nothing to refresh
    }

    const forceRefresh = await this.consumeAuthRecoveryEdge();
    if (!forceRefresh && Date.now() - this.lastRefreshedAt < CREDENTIAL_REFRESH_INTERVAL_MS) {
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

  /**
   * Returns true exactly once, on the first call after the analytics-auth-status marker
   * transitions from invalid to cleared — the signal that a re-login just stored fresh
   * credentials. Best-effort: a failed status read never blocks the normal throttled path.
   */
  private async consumeAuthRecoveryEdge(): Promise<boolean> {
    try {
      const invalid = (await getAnalyticsAuthStatus()) !== null;
      if (invalid) {
        this.sawAuthInvalid = true;
        return false;
      }
      if (this.sawAuthInvalid) {
        this.sawAuthInvalid = false;
        return true;
      }
    } catch (error) {
      logger.debug('[credential-refresh] Failed to read analytics-auth-status marker; keeping the throttled refresh path', error);
    }
    return false;
  }
}
