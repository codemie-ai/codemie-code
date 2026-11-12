/**
 * The Desktop runtime's hold on the Cowork producer: one producer run at a time, started from a poll and never awaited
 * by it, so a slow or failing run never holds the poll.
 */

import { ClaudeDesktopTelemetryAdapter } from '@/telemetry/clients/claude-desktop/ClaudeDesktopTelemetryAdapter.js';
import type { DesktopTelemetryRuntimeConfig, LocalTelemetryAdapter } from '@/telemetry/runtime/types.js';
import { logger } from '@/utils/logger.js';
import { CoworkEventProducer } from './CoworkEventProducer.js';

export type CoworkProducer = Pick<CoworkEventProducer, 'run'>;

/** A run still in flight this long after its start is warned about once. */
const OVERDUE_RUN_MS = 5 * 60 * 1000;

export class CoworkRunner {
  /** The producer run in flight, if any. */
  inFlight?: Promise<void>;
  private inFlightSince = 0;
  private overdueWarned = false;

  constructor(private readonly producer: CoworkProducer) {}

  /** The runner of the given producer, else of a new one with the daemon's profile for Claude Desktop's own adapter; none for another adapter. */
  static forAdapter(adapter: LocalTelemetryAdapter, config: DesktopTelemetryRuntimeConfig, producer?: CoworkProducer): CoworkRunner | undefined {
    if (producer) return new CoworkRunner(producer);
    return adapter instanceof ClaudeDesktopTelemetryAdapter
      ? new CoworkRunner(new CoworkEventProducer({ profile: config.profile, inactivityTimeoutMs: config.inactivityTimeoutMs }))
      : undefined;
  }

  /**
   * Starts a producer run unless one is in flight. A run found still in flight 5 minutes after its start is warned
   * about once; no second run starts beside it.
   */
  startIfIdle(now: number): void {
    if (this.inFlight) {
      if (!this.overdueWarned && now - this.inFlightSince >= OVERDUE_RUN_MS) {
        this.overdueWarned = true;
        logger.warn('[desktop-telemetry] Cowork producer run still in flight after 5 minutes; no new run starts until it ends', {
          startedAt: new Date(this.inFlightSince).toISOString(),
        });
      }
      return;
    }
    this.inFlightSince = now;
    this.overdueWarned = false;
    this.inFlight = Promise.resolve()
      .then(() => this.producer.run(now))
      .catch((error) => {
        logger.warn('[desktop-telemetry] Cowork producer run failed; retried at the next poll', {
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        this.inFlight = undefined;
      });
  }
}
