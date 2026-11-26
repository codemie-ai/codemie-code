import type { DesktopTelemetryRuntimeConfig } from '@/telemetry/runtime/types.js';
import {
  isDesktopConnectedTo,
  readDesktopGatewayState
} from '@/telemetry/clients/claude-desktop/claude-desktop.gateway.js';
import { logger } from '@/utils/logger.js';

/** Whether Desktop's applied config points at this daemon, read once a poll. */
export class DesktopConnection {
  /** Whether the last poll found Desktop connected to this daemon; undefined before the first poll. */
  private connected?: boolean;
  /** Whether the last poll's config read found Desktop's config naming a gateway; true when that read threw. */
  namesGateway = true;
  /** Consecutive "not connected" reads while connected: one alone (a config read mid-write, say) is not a change. */
  private notConnectedReads = 0;

  /**
   * @param collectingSince The activity gate and the baseline cutoff of a never-synced session: the daemon's start
   * when the first poll found Desktop connected, else the time of the poll on which it last turned connected.
   */
  constructor(
    private readonly config: DesktopTelemetryRuntimeConfig,
    public collectingSince: number
  ) {}

  /**
   * Whether Desktop's applied config points at this daemon; a reader that fails counts as not connected. While
   * connected, only the second "not connected" read in a row turns it not connected; a single one reads as connected.
   * A change moves the activity gate (on turning connected after the first poll) and is told to the daemon.
   */
  async check(now: number): Promise<boolean> {
    let connected = false;
    this.namesGateway = true;
    try {
      const { gateway, namesGateway } = await (this.config.readDesktopGateway ?? readDesktopGatewayState)();
      this.namesGateway = namesGateway;
      connected = isDesktopConnectedTo(gateway, this.config.gatewayKey, this.config.port);
    } catch (error) {
      logger.warn('[desktop-telemetry] Claude Desktop config not read; not collecting this poll', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (connected || !this.connected) {
      this.notConnectedReads = 0;
    } else if (++this.notConnectedReads < 2) {
      logger.debug('[desktop-telemetry] Claude Desktop read as not connected once; still collecting');
      return true;
    } else {
      this.notConnectedReads = 0;
    }
    const previous = this.connected;
    this.connected = connected;
    if (connected === (previous ?? false)) return connected;
    if (connected && previous !== undefined) this.collectingSince = now;
    logger.info(connected ? '[desktop-telemetry] Claude Desktop connected; collecting' : '[desktop-telemetry] Claude Desktop not connected; collection paused', {
      ...(connected && { since: new Date(this.collectingSince).toISOString() })
    });
    try {
      await this.config.onDesktopConnectedChange?.(connected ? new Date(this.collectingSince).toISOString() : undefined);
    } catch (error) {
      logger.warn('[desktop-telemetry] Daemon not told of the Desktop connection change', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return connected;
  }
}
