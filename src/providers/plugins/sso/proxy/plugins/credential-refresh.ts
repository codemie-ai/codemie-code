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
 * OTLP telemetry forwarding is the one consumer NOT wired to this class: it has its own
 * resume-after-re-auth path (`markCredentialsStale`/`resolveFreshCredentials`/
 * `clearCredentialsStale` in `otlp-spool/auth-state.ts`), gated on an observed 401/403, plus a
 * periodic re-read of the stored login on each daemon tick (`otlp.plugin.ts`, throttled by
 * `CREDENTIAL_REFRESH_INTERVAL_MS`, so the effective interval is the tick interval). Left as-is rather than merged into this
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
import { getLastSignInAt } from '../../sso.detached-login.js';
import { readWithDeadline, PROXY_STORE_READ_DEADLINE_MS } from '../../session/cookie-auth.js';

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
  /** Last lock `succeededAt` handled (read for, or already in the initial snapshot); a different non-null value means a newer sign-in. */
  private lastActedStamp: number | null = null;
  /** Start time of the latest read that came back without usable credentials. */
  private lastFailedReadAt = Number.NEGATIVE_INFINITY;
  private readsStarted = 0;
  private lastAssignedRead = 0;
  /** A read `refresh()` started because of a sign-in signal; concurrent `refresh()` calls join it. */
  private bypassRead: Promise<T> | null = null;
  /** The sign-in stamp `bypassRead` was started under. */
  private bypassStamp: number | null = null;
  /** A read started by `refreshNow()`; only other `refreshNow()` calls join it. */
  private refreshNowRead: Promise<T | null> | null = null;
  private readonly readStore: () => Promise<T | null>;
  /** The initial snapshot already reflects any sign-in that finished before this time. */
  private readonly createdAt = Date.now();

  constructor(initialCredentials: T, private readonly params: CredentialRefreshParams) {
    this.current = initialCredentials;
    this.readStore = readWithDeadline(() => this.readStoredCredentials(), PROXY_STORE_READ_DEADLINE_MS);
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
   * through the window still leaves stale cookies in `current` for whatever is left of it. Two
   * signals bypass the throttle so the very next call re-reads:
   * - the sign-in lock's `succeededAt` stamp differs from the one last acted on: covers the
   *   detached sign-in, which can mark, sign in and clear the marker entirely between two calls.
   *   Compared by identity, not against `lastRefreshedAt`, so a stepped-back clock cannot turn
   *   every call into a store read. A stamp from before this instance was created is already in
   *   the initial snapshot, so the first one seen is only remembered;
   * - the shared analytics-auth-status marker was seen invalid and then cleared: covers sign-ins
   *   that clear the marker without stamping the lock (`codemie profile login`, the launch-time
   *   re-auth, an accepted metrics send).
   *
   * `lastRefreshedAt` is set when a read starts, so a failing store costs at most one read per
   * window. Both sign-in signals are spent only by a read that returned credentials: after a failed,
   * empty or timed-out read the stamp stays unacted on and the marker edge is re-armed, and each
   * bypass is allowed again once a window has passed since that attempt (the plain throttled path
   * then reads and commits the stamp on success). Calls arriving while a bypass read is pending await it (after a sign-in a resumed
   * agent often sends several requests at once, and each old-cookie request would be rejected
   * again); calls arriving during a plain throttle read get the snapshot at once.
   */
  async refresh(): Promise<T> {
    if (!('cookies' in this.current)) {
      return this.current; // JWT — static, nothing to refresh
    }

    const [markerInvalid, stamp] = await Promise.all([this.readMarkerInvalid(), getLastSignInAt(this.params)]);

    // From here to publishing the pending read there is no await, so two calls can never both
    // start a bypass read or let one slip past the other.
    if (stamp !== null && this.lastActedStamp === null && stamp <= this.createdAt) {
      this.lastActedStamp = stamp;
    }
    const markerEdge = this.consumeAuthRecoveryEdge(markerInvalid);
    const stampChanged =
      stamp !== null &&
      stamp !== this.lastActedStamp &&
      Date.now() - this.lastFailedReadAt >= CREDENTIAL_REFRESH_INTERVAL_MS;
    if (!markerEdge && stampChanged && this.bypassRead && this.bypassStamp === stamp) {
      return this.bypassRead;
    }
    if (markerEdge || stampChanged) {
      this.lastRefreshedAt = Date.now();
      const pending = this.readAndAssign(stamp)
        .then((fresh) => {
          if (!fresh && markerEdge) {
            this.sawAuthInvalid = true;
          }
          return this.current;
        })
        .finally(() => {
          if (this.bypassRead === pending) {
            this.bypassRead = null;
            this.bypassStamp = null;
          }
        });
      this.bypassRead = pending;
      this.bypassStamp = stamp;
      return pending;
    }
    if (this.bypassRead) {
      return this.bypassRead;
    }
    if (Date.now() - this.lastRefreshedAt < CREDENTIAL_REFRESH_INTERVAL_MS) {
      return this.current;
    }
    this.lastRefreshedAt = Date.now();
    await this.readAndAssign(stamp);
    return this.current;
  }

  /**
   * Re-reads the store now, ignoring the throttle, and returns what it holds (also adopted as the
   * snapshot), or null when the read failed, timed out or came back empty. Never joins a
   * `refresh()` read: a throttle read begun before a sign-in would hand back the old snapshot.
   */
  refreshNow(): Promise<T | null> {
    if (!('cookies' in this.current)) {
      return Promise.resolve(null);
    }
    if (this.refreshNowRead) {
      return this.refreshNowRead;
    }
    const pending = (async (): Promise<T | null> => {
      const stamp = await getLastSignInAt(this.params);
      const fresh = await this.readAndAssign(stamp);
      if (fresh) {
        this.lastRefreshedAt = Date.now();
      }
      return fresh;
    })().finally(() => {
      if (this.refreshNowRead === pending) {
        this.refreshNowRead = null;
      }
    });
    this.refreshNowRead = pending;
    return pending;
  }

  /**
   * One store read under the deadline. Reads are numbered at start; a read adopts its result only
   * if no later-started read has adopted one already, so a slow older read never overwrites a newer
   * snapshot, and only then does the sign-in stamp it was started under count as handled. Empty,
   * failed and timed-out reads keep the last known-good credentials and leave the stamp unspent.
   */
  private async readAndAssign(stamp: number | null): Promise<T | null> {
    const readNumber = ++this.readsStarted;
    const startedAt = Date.now();
    const fresh = await this.readStore();
    if (!fresh) {
      this.lastFailedReadAt = Math.max(this.lastFailedReadAt, startedAt);
    } else if (readNumber > this.lastAssignedRead) {
      this.lastAssignedRead = readNumber;
      this.current = fresh;
      if (stamp !== null) {
        this.lastActedStamp = stamp;
      }
    }
    return fresh;
  }

  private async readStoredCredentials(): Promise<T | null> {
    try {
      const stored = await getStoredPlatformCredentials(this.params);
      return (stored?.credentials as T | undefined) ?? null;
    } catch (error) {
      logger.debug('[credential-refresh] Failed to re-read stored SSO credentials; using the last known-good snapshot', error);
      return null;
    }
  }

  /** Whether the analytics-auth-status marker is invalid; null when it could not be read. */
  private async readMarkerInvalid(): Promise<boolean | null> {
    try {
      return (await getAnalyticsAuthStatus()) !== null;
    } catch (error) {
      logger.debug('[credential-refresh] Failed to read analytics-auth-status marker; keeping the throttled refresh path', error);
      return null;
    }
  }

  /**
   * Returns true exactly once, on the first call after the analytics-auth-status marker
   * transitions from invalid to cleared — the signal that a re-login just stored fresh
   * credentials. It is held back while the latest failed read is younger than the throttle window
   * and re-armed by `refresh()` when the read it triggered fails, so a broken store costs at most
   * one read per window. An unreadable marker never blocks the normal throttled path.
   */
  private consumeAuthRecoveryEdge(markerInvalid: boolean | null): boolean {
    if (markerInvalid === null) {
      return false;
    }
    if (markerInvalid) {
      this.sawAuthInvalid = true;
      return false;
    }
    if (this.sawAuthInvalid && Date.now() - this.lastFailedReadAt >= CREDENTIAL_REFRESH_INTERVAL_MS) {
      this.sawAuthInvalid = false;
      return true;
    }
    return false;
  }
}
