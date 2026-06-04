/**
 * ProxyWatcher — runs inside the proxy daemon.
 *
 * Periodically deep-checks the proxy. On failure it restarts the proxy
 * IN-PROCESS on the same pinned port (Approach A). Unauthorized failures
 * (expired SSO session) cannot be fixed without an interactive login, so the
 * watcher gives up and lets the daemon record an unhealthy state instead of
 * looping forever. A large gap between timer ticks is treated as a sleep/wake
 * event and triggers an immediate re-check.
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
}

export interface WatcherOptions {
  port: number;
  gatewayKey: string;
  intervalMs?: number;        // default 30000
  maxRestartAttempts?: number; // default 3
}

export class ProxyWatcher {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private checking = false;
  private restartAttempts = 0;
  private lastTick = Date.now();
  private readonly intervalMs: number;
  private readonly maxRestartAttempts: number;

  constructor(
    private readonly opts: WatcherOptions,
    private readonly callbacks: WatcherCallbacks
  ) {
    this.intervalMs = opts.intervalMs ?? 30000;
    this.maxRestartAttempts = opts.maxRestartAttempts ?? 3;
  }

  start(): void {
    this.lastTick = Date.now();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    // Do not keep the event loop alive solely for the watcher.
    this.timer.unref?.();
    logger.debug(`[proxy-watcher] Started (interval ${this.intervalMs}ms, port ${this.opts.port})`);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.checking) return;
    this.checking = true;
    try {
      const now = Date.now();
      const drift = now - this.lastTick - this.intervalMs;
      this.lastTick = now;
      if (drift > this.intervalMs) {
        logger.info(
          `[proxy-watcher] Detected ~${Math.round(drift / 1000)}s gap (likely sleep/wake) — checking now`
        );
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

      // Expired session cannot be recovered without interactive login.
      if (result.code === 'unauthorized') {
        await this.callbacks.onGiveUp(result.reason ?? 'SSO session expired');
        this.stop();
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
      this.checking = false;
    }
  }
}
