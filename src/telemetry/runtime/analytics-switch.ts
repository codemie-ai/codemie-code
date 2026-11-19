import {
  getClaudeAnalyticsPreferencesPath,
  readClaudeAnalyticsPreferences
} from '@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js';
import type { Session } from '@/agents/core/session/types.js';
import type { RuntimeCheckpoint } from '@/telemetry/runtime/checkpoints.js';
import type { TrackedSession } from '@/telemetry/runtime/desktop-session.js';
import type { DesktopSessionDelivery } from '@/telemetry/runtime/DesktopSessionDelivery.js';
import { logger } from '@/utils/logger.js';

export type ClaudeAnalyticsSwitch = 'on' | 'off' | 'corrupt';

export type ClaudeAnalyticsSwitchState =
  | { state: 'corrupt' }
  | { state: 'on' | 'off'; generation: number };

/** The Claude analytics on/off switch and its collection generation (`claude-analytics.json`); an unreadable file is `corrupt`. */
export async function readClaudeAnalyticsSwitchState(): Promise<ClaudeAnalyticsSwitchState> {
  const prefs = await readClaudeAnalyticsPreferences();
  if (prefs.kind === 'corrupt') return { state: 'corrupt' };
  return { state: prefs.value.enabled ? 'on' : 'off', generation: prefs.value.collectionGeneration };
}

export async function readClaudeAnalyticsSwitch(): Promise<ClaudeAnalyticsSwitch> {
  return (await readClaudeAnalyticsSwitchState()).state;
}

/** Collection runs only while the switch is on: off and corrupt both fail closed. */
export async function claudeAnalyticsCollecting(): Promise<boolean> {
  return (await readClaudeAnalyticsSwitch()) === 'on';
}

export interface AnalyticsSwitchCheck {
  collecting: boolean;
  /** Set on the poll that turned collection back on: collection is forward-only from this time. */
  enabledAt?: number;
}

/**
 * The daemon's view of the analytics switch. Off closes the live records locally (nothing sent) and forgets the
 * tracked sessions; a corrupt file collects nothing and keeps the last valid state. Turning on is forward-only: it waits
 * for that close, then moves known records' baseline to the enable time. A toggle no poll saw (the daemon down, or off
 * and on between two polls) shows as another `collectionGeneration` than the one a record was last synced under, and
 * is made forward-only the same way.
 */
export class AnalyticsSwitch {
  /** The last valid read; a corrupt read leaves it, so a flap through corrupt is no edge. */
  private state?: 'on' | 'off';
  /** The local close of the live records at the switch-off did not finish; collection stays closed until it does. */
  private closePending = false;
  private corruptWarned = false;
  private generation?: number;
  /** When this daemon first saw {@link generation}: the baseline of a record that spans an unobserved toggle. */
  private generationSince?: number;
  /** The time analytics were last observed turned back on: a known record skips what was written before it. */
  private forwardOnlyFrom?: number;
  /** The records already rebased since the last observed edge, or created after it. */
  private readonly rebased = new Set<string>();

  async check(
    now: number,
    tracked: Map<string, TrackedSession>,
    delivery: Pick<DesktopSessionDelivery, 'closeLiveRecordsLocally'>
  ): Promise<AnalyticsSwitchCheck> {
    const read = await readClaudeAnalyticsSwitchState();
    if (read.state === 'corrupt') {
      if (!this.corruptWarned) {
        this.corruptWarned = true;
        logger.warn('[desktop-telemetry] Analytics preferences file unreadable; not collecting', {
          path: getClaudeAnalyticsPreferencesPath()
        });
      }
      return { collecting: false };
    }
    this.corruptWarned = false;
    if (read.state === 'off') {
      if (this.state !== 'off' || this.closePending) {
        if (this.state !== 'off') logger.info('[desktop-telemetry] Analytics switched off; closing records locally');
        this.state = 'off';
        await this.closeLiveRecords(tracked, delivery);
      }
      return { collecting: false };
    }
    let enabledAt: number | undefined;
    if (this.state === 'off') {
      if (this.closePending) await this.closeLiveRecords(tracked, delivery);
      if (this.closePending) return { collecting: false };
      enabledAt = now;
    } else if (this.generation !== undefined && read.generation !== this.generation) {
      enabledAt = now;
    }
    if (enabledAt !== undefined) {
      this.forwardOnlyFrom = enabledAt;
      this.rebased.clear();
      logger.info('[desktop-telemetry] Analytics switched on; collecting forward only', { since: new Date(enabledAt).toISOString() });
    }
    if (this.generation !== read.generation) this.generationSince = now;
    this.state = 'on';
    this.generation = read.generation;
    return { collecting: true, enabledAt };
  }

  /**
   * The checkpoint fields that keep a known record forward-only, to merge into its checkpoint: the later of its pending
   * baseline and the cutoff it is owed, and the generation it is now current with. A record without a stamp predates
   * the generation: it adopts the current one without a rebase, since an observed toggle is covered by the edge.
   */
  checkpointFields(record: Session): Pick<RuntimeCheckpoint, 'baselineCutoffMs' | 'collectionGeneration'> {
    const checkpoint = record.runtimeCheckpoint;
    let cutoff: number | undefined;
    if (!this.rebased.has(record.sessionId)) {
      this.rebased.add(record.sessionId);
      const stamp = checkpoint?.collectionGeneration;
      cutoff = this.forwardOnlyFrom ?? (stamp !== undefined && stamp !== this.generation ? this.generationSince : undefined);
    }
    return {
      ...(cutoff !== undefined && { baselineCutoffMs: Math.max(checkpoint?.baselineCutoffMs ?? cutoff, cutoff) }),
      ...(this.generation !== undefined && { collectionGeneration: this.generation })
    };
  }

  /** A record created now needs no rebase; it is stamped with the current generation. */
  stampNew(session: Session): Session {
    this.rebased.add(session.sessionId);
    if (this.generation !== undefined && session.runtimeCheckpoint) {
      session.runtimeCheckpoint.collectionGeneration = this.generation;
    }
    return session;
  }

  /** Closes the live records locally, the tracked sessions' last activity ending the active ones; forgets the tracked sessions once all are closed. */
  private async closeLiveRecords(
    tracked: Map<string, TrackedSession>,
    delivery: Pick<DesktopSessionDelivery, 'closeLiveRecordsLocally'>
  ): Promise<void> {
    const activity = new Map([...tracked.values()].map(session => [session.codemieSessionId, session.lastSeenActivityAt]));
    this.closePending = !(await delivery.closeLiveRecordsLocally(activity));
    if (!this.closePending) tracked.clear();
  }
}
