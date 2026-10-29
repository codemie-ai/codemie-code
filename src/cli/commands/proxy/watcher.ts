/**
 * ProxyWatcher — runs inside the proxy daemon.
 *
 * Periodically deep-checks the proxy. On failure it restarts the proxy
 * IN-PROCESS on the same pinned port (Approach A). An unauthorized failure
 * (expired SSO session) cannot be fixed without an interactive login, so the
 * watcher enters a waiting state instead of restarting or exiting: it stops
 * deep-checking (a deep check goes through the proxy and would re-open the
 * browser sign-in each time), polls only the local credential store, and
 * resumes as soon as new credentials appear. A large gap between timer ticks
 * is treated as a sleep/wake event and triggers an immediate re-check.
 */
import { logger } from '../../../utils/logger.js';
import { checkProxyHealth, ProxyHealthResult } from './health-check.js';

export interface WatcherCallbacks {
  /** Tear down the current proxy and re-listen on the same pinned port. */
  restart: () => Promise<void>;
  /** Called when a check passes (record lastHealthyAt / clear reason). */
  onHealthy: (result: ProxyHealthResult) => Promise<void>;
  /** Called when recovery is impossible or exhausted (record unhealthy + reason). */
  onGiveUp: (reason: string) => Promise<void>;
  /** Called once when the watcher starts waiting for a new sign-in (record the reason and the rejected credentials). */
  onAuthRequired: (reason: string) => Promise<void>;
  /** Cheap, local check: has a sign-in different from the rejected one been stored? Must not touch the network. */
  hasNewCredentials: () => Promise<boolean>;
  /** New credentials are stored: bring the proxy back if it is running in its fallback mode. */
  onCredentialsRestored: () => Promise<void>;
}

export interface WatcherOptions {
  port: number;
  gatewayKey: string;
  intervalMs?: number;        // default 30000
  maxRestartAttempts?: number; // default 3
  authPollMs?: number;        // default 5000: credential-store poll while waiting for a sign-in
}

export class ProxyWatcher {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private checking = false;
  private authRequired = false;
  private restartAttempts = 0;
  private lastTick = Date.now();
  private expectedDelay = 0;
  private readonly intervalMs: number;
  private readonly maxRestartAttempts: number;
  private readonly authPollMs: number;

  constructor(
    private readonly opts: WatcherOptions,
    private readonly callbacks: WatcherCallbacks
  ) {
    this.intervalMs = opts.intervalMs ?? 30000;
    this.maxRestartAttempts = opts.maxRestartAttempts ?? 3;
    this.authPollMs = opts.authPollMs ?? 5000;
  }

  start(): void {
    this.lastTick = Date.now();
    this.schedule();
    logger.debug(`[proxy-watcher] Started (interval ${this.intervalMs}ms, port ${this.opts.port})`);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Chained timeouts rather than setInterval: the delay differs while waiting for a sign-in. */
  private schedule(): void {
    if (this.stopped) return;
    this.expectedDelay = this.authRequired ? this.authPollMs : this.intervalMs;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, this.expectedDelay);
    // Do not keep the event loop alive solely for the watcher.
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.checking) return;
    this.checking = true;
    try {
      const now = Date.now();
      const drift = now - this.lastTick - this.expectedDelay;
      if (drift > this.intervalMs) {
        logger.info(
          `[proxy-watcher] Detected ~${Math.round(drift / 1000)}s gap (likely sleep/wake) — checking now`
        );
      }

      if (this.authRequired) {
        if (!(await this.callbacks.hasNewCredentials())) return;
        logger.info('[proxy-watcher] New sign-in detected — resuming');
        this.authRequired = false;
        await this.callbacks.onCredentialsRestored();
      }

      const result = await checkProxyHealth({
        port: this.opts.port,
        gatewayKey: this.opts.gatewayKey,
        deep: true,
      });

      if (result.healthy) {
        this.restartAttempts = 0;
        await this.callbacks.onHealthy(result);
        return;
      }

      logger.warn(`[proxy-watcher] Proxy unhealthy: ${result.reason ?? 'unknown'}`);

      // Expired session cannot be recovered without an interactive login: wait for one.
      if (result.code === 'unauthorized') {
        this.restartAttempts = 0;
        this.authRequired = true;
        await this.callbacks.onAuthRequired(result.reason ?? 'SSO session expired');
        return;
      }

      if (this.restartAttempts >= this.maxRestartAttempts) {
        await this.callbacks.onGiveUp(
          `Proxy did not recover after ${this.maxRestartAttempts} restart attempts. ` +
          `Last reason: ${result.reason ?? 'unknown'}`
        );
        this.stop();
        return;
      }

      this.restartAttempts++;
      const backoffMs = Math.min(this.intervalMs, 1000 * 2 ** (this.restartAttempts - 1));
      logger.info(
        `[proxy-watcher] Restart attempt ${this.restartAttempts}/${this.maxRestartAttempts} after ${backoffMs}ms`
      );
      await new Promise<void>((r) => setTimeout(r, backoffMs));
      try {
        await this.callbacks.restart();
        logger.info('[proxy-watcher] Proxy restarted on the same port');
      } catch (error) {
        logger.error('[proxy-watcher] Restart failed', error);
      }
    } catch (error) {
      logger.error('[proxy-watcher] Tick failed', error);
    } finally {
      this.lastTick = Date.now();
      this.checking = false;
    }
  }
}
