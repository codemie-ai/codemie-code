import { randomUUID } from 'crypto';
import { SessionStore } from '@/agents/core/session/SessionStore.js';
import { hostOf } from '@/agents/core/session/send-path.js';
import type { Session } from '@/agents/core/session/types.js';
import { reconcileLockPath } from '@/agents/core/session/stale-session-reconciliation.js';
import { SessionSyncer } from '@/providers/plugins/sso/session/SessionSyncer.js';
import type {
  DesktopTelemetryRuntimeConfig,
  LocalTelemetryAdapter,
  LocalTelemetryDiscoveredSession
} from '@/telemetry/runtime/types.js';
import { setRuntimeCheckpoint } from '@/telemetry/runtime/checkpoints.js';
import { restoreCompletedFiles } from '@/telemetry/runtime/completed-files.js';
import { DesktopSessionDelivery } from '@/telemetry/runtime/DesktopSessionDelivery.js';
import { DesktopSessionMetrics } from '@/telemetry/runtime/DesktopSessionMetrics.js';
import {
  DESKTOP_REDELIVERY_INTERVAL_MS,
  DESKTOP_REOPEN_LOCK_BUDGET_MS,
  daemonOwner, hasActivityAfter,
  isForeignRecord,
  isSameFingerprint,
  readTranscriptFingerprint,
  detectAttribution,
  type Attribution,
  type TrackedSession
} from '@/telemetry/runtime/desktop-session.js';
import { ReconcileLockHeldError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { acquirePidLock } from '@/utils/pid-lock.js';
import { CoworkRunner, type CoworkProducer } from '@/telemetry/runtime/cowork/CoworkRunner.js';

export class DesktopTelemetryRuntime {
  private readonly sessionStore = new SessionStore();
  private readonly metrics: DesktopSessionMetrics;
  private readonly delivery: DesktopSessionDelivery;
  private readonly trackedSessions = new Map<string, TrackedSession>();
  // externalSessionId -> CodeMie session id for every session persisted by this or a previous
  // daemon. Built with one directory scan so polls never rescan ~/.codemie/sessions per session.
  private knownSessionIds?: Map<string, string>;
  private readonly startedAt = Date.now();
  private timer?: NodeJS.Timeout;
  private lastPollAt = this.startedAt;
  private lastRedeliveryAt = this.startedAt;
  private isPolling = false;
  /**
   * A re-track lock wait of this poll failed: `lastPollAt` is held back so the next poll re-reads this window, for as
   * long as the wait keeps failing. Discovery is bounded by the sessions active since `startedAt`, so the cost is
   * their metadata reads per poll and one lock wait per poll until the holder releases.
   */
  private reopenLockFailed = false;
  private startupPass?: Promise<void>;
  private startupChain?: Promise<void>;
  private stopped = false;
  private redeliveryPass?: Promise<void>;
  /** Turns Cowork sessions into plugin events in the proxy's spool; only for Claude Desktop's own adapter. */
  private readonly cowork?: CoworkRunner;

  constructor(
    private readonly adapter: LocalTelemetryAdapter,
    private readonly config: DesktopTelemetryRuntimeConfig,
    cowork?: CoworkProducer
  ) {
    this.metrics = new DesktopSessionMetrics(config, this.sessionStore);
    this.delivery = new DesktopSessionDelivery(config, this.sessionStore, new SessionSyncer(), adapter, this.metrics);
    this.cowork = CoworkRunner.forAdapter(adapter, config, cowork);
  }

  /**
   * One start and one stop per instance: a start() after stop() polls nothing (the daemon constructs one runtime
   * per process).
   */
  async start(): Promise<void> {
    // The start-up pass renames records; the scan runs before it so no record is missed between listing and reading
    try {
      this.knownSessionIds ??= await this.indexSessions();
    } catch (error) {
      logger.error('[desktop-telemetry] Session index failed; built at the next poll', error);
    }
    // Records a previous daemon left are finalized and delivered before the first poll: a poll that re-tracked a
    // predecessor's `active` record first would keep the downtime inside one stretch under this daemon.
    // Detached: the daemon starts its proxy watcher after start(), which must not wait for the pass's sends.
    this.startupPass = this.delivery.reconcileRecords(true).catch((error) => {
      logger.error('[desktop-telemetry] Start-up scan failed:', error);
    });
    this.startupChain = this.startupPass.then(async () => {
      if (this.stopped) return;
      await this.poll().catch((error) => {
        logger.error('[desktop-telemetry] Poll failed:', error);
      });
      if (this.stopped) return;
      this.timer = setInterval(() => {
        this.poll().catch((error) => {
          logger.error('[desktop-telemetry] Poll failed:', error);
        });
      }, this.config.pollIntervalMs);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    // Final poll to catch sessions whose transcript was written after the last regular poll
    // but before proxy stop (e.g. Code tab sessions where transcript write is async).
    await this.poll().catch((error) => {
      logger.error('[desktop-telemetry] Final poll on stop failed:', error);
    });

    // ponytail: no deadline here and stopDaemon sends SIGKILL after 5 s — a session killed mid-finalize stays
    // `completed` without its end metric (delivered by the next start) or `active` (finalized by the next start)
    for (const tracked of this.trackedSessions.values()) {
      try {
        await this.finalizeSession(tracked.codemieSessionId, 'desktop-daemon-stop', tracked.lastSeenActivityAt);
      } catch (error) {
        logger.error('[desktop-telemetry] Finalization on stop failed:', {
          sessionId: tracked.codemieSessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  async triggerPoll(): Promise<void> {
    await this.poll();
  }


  private async poll(): Promise<void> {
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;
    const now = Date.now();

    try {
      // Every start orders its first poll after the start-up pass; a poll asked for during the pass (triggerPoll, stop())
      // waits for it only when the start-up index failed, so the index never lists while the pass renames records
      // ponytail: that poll waits for the whole start-up pass (network sends per record); polling resumes after it
      if (!this.knownSessionIds) await this.startupPass;
      this.knownSessionIds ??= await this.indexSessions();
      const discoveredSessions = await this.adapter.discoverSessions(this.lastPollAt - this.config.pollIntervalMs);
      logger.debug('[desktop-telemetry] Poll tick', {
        discovered: discoveredSessions.length,
        tracked: this.trackedSessions.size,
        lastPollAt: new Date(this.lastPollAt).toISOString(),
      });
      for (const discovered of discoveredSessions) {
        // Gate on activity, not creation time. A conversation opened before the daemon
        // started is still live work the moment the user types into it, and keying on
        // createdAt made every proxy restart orphan all existing chats permanently.
        // Sessions genuinely idle since startup are still skipped, so no backlog is replayed.
        if (discovered.updatedAt < this.startedAt) {
          continue;
        }
        try {
          await this.pollSession(discovered);
        } catch (error) {
          logger.error('[desktop-telemetry] Session poll failed; retried at the next poll', {
            externalSessionId: discovered.externalSessionId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (!this.stopped) this.cowork?.startIfIdle(now);
      await this.finalizeInactive(now);
      this.startRedeliveryIfDue(now);
    } finally {
      // held back on a failed reopen lock wait
      if (!this.reopenLockFailed) {
        this.lastPollAt = now;
      }
      this.reopenLockFailed = false;
      this.isPolling = false;
    }
  }

  /** The index of this host's records: a record of another CodeMie host belongs to that host's daemon. */
  private indexSessions(): Promise<Map<string, string>> {
    return this.sessionStore.indexSessionsByExternalId(
      this.config.clientType,
      (record) => !isForeignRecord(record, this.metrics.credentialsUrl)
    );
  }

  /** Finalizes every tracked session idle past the inactivity timeout; a failure is retried at the next poll. */
  private async finalizeInactive(now: number): Promise<void> {
    for (const [externalSessionId, tracked] of this.trackedSessions) {
      const inactiveForMs = now - tracked.lastSeenActivityAt;
      if (inactiveForMs < this.config.inactivityTimeoutMs) {
        continue;
      }

      logger.info('[desktop-telemetry] Session inactive — finalizing', {
        externalSessionId,
        inactiveForMs,
        codemieSessionId: tracked.codemieSessionId,
      });
      try {
        await this.finalizeSession(tracked.codemieSessionId, 'desktop-inactive-timeout', tracked.lastSeenActivityAt);
        this.trackedSessions.delete(externalSessionId);
      } catch (error) {
        logger.error('[desktop-telemetry] Inactive session finalization failed; retried at the next poll', {
          externalSessionId,
          codemieSessionId: tracked.codemieSessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /** Starts a re-delivery pass every {@link DESKTOP_REDELIVERY_INTERVAL_MS} unless one is running; each pass sends at most `RECONCILE_PER_START` records. */
  private startRedeliveryIfDue(now: number): void {
    // Not awaited: a pass whose sends hang must not stall the polls
    if (!this.redeliveryPass && now - this.lastRedeliveryAt >= DESKTOP_REDELIVERY_INTERVAL_MS) {
      this.lastRedeliveryAt = now;
      this.redeliveryPass = this.delivery.reconcileRecords(false)
        .catch((error) => {
          logger.error('[desktop-telemetry] Re-delivery pass failed:', error);
        })
        .finally(() => {
          this.redeliveryPass = undefined;
        });
    }
  }

  private async pollSession(discovered: LocalTelemetryDiscoveredSession): Promise<void> {
    const knownSessionIds = this.knownSessionIds!;
    const tracked = this.trackedSessions.get(discovered.externalSessionId);
    // Taken before parsing, so a write that lands mid-processing is picked up next tick.
    const transcript = await readTranscriptFingerprint(discovered.transcriptPath);

    // Desktop bumps lastActivityAt without necessarily appending to the transcript.
    // Nothing new to parse or sync, so keep the session alive and skip the work.
    if (tracked && transcript && isSameFingerprint(tracked.transcript, transcript)) {
      tracked.lastSeenActivityAt = Math.max(tracked.lastSeenActivityAt, discovered.updatedAt);
      return;
    }

    if (!tracked) {
      logger.info('[desktop-telemetry] New session detected', {
        externalSessionId: discovered.externalSessionId,
        agentSessionId: discovered.agentSessionId,
        workingDirectory: discovered.workingDirectory,
        transcriptPath: discovered.transcriptPath,
      });
    }

    const session = await this.ensureSession(
      discovered,
      tracked?.codemieSessionId ?? knownSessionIds.get(discovered.externalSessionId)
    );
    if (!session || session === 'idle') {
      this.reopenLockFailed ||= !session;
      return;
    }
    knownSessionIds.set(discovered.externalSessionId, session.sessionId);
    const nextTracked: TrackedSession = {
      codemieSessionId: session.sessionId,
      lastSeenActivityAt: discovered.updatedAt,
      transcript: tracked?.transcript
    };
    this.trackedSessions.set(discovered.externalSessionId, nextTracked);

    await this.delivery.processSession(session, discovered, true);
    // Record the fingerprint only once processing succeeded: a failed parse or sync must
    // not mark this transcript state as handled, or the delta would wait for the next write.
    nextTracked.transcript = transcript;
  }

  /**
   * The record of a discovered session: the known one re-tracked under its reconcile lock, else a new one.
   * Undefined when its lock stays held past {@link DESKTOP_REOPEN_LOCK_BUDGET_MS}; `idle` when it is `completed` with no newer activity.
   */
  private async ensureSession(
    discovered: LocalTelemetryDiscoveredSession,
    knownSessionId?: string
  ): Promise<Session | 'idle' | undefined> {
    if (knownSessionId) {
      const retracked = await this.retrackUnderLock(knownSessionId, discovered);
      if (retracked !== null) {
        return retracked;
      }
    }

    const attribution = await detectAttribution(discovered.workingDirectory, this.config.profile);
    const [gitBranch, repository, project] = attribution;
    logger.info('[desktop-telemetry] Session resolved', {
      externalSessionId: discovered.externalSessionId,
      workingDirectory: discovered.workingDirectory,
      repository,
      gitBranch,
      project,
    });

    // Publish through the shared resolver: it keeps a confirmed per-request lookup ahead of
    // this poll-derived directory (process CWD is more precise), while still replacing a
    // tentative TTL-window guess.
    this.config.repositoryResolver?.recordDiscoveredSession(discovered.agentSessionId, repository);

    // A chat CodeMie has never synced that already existed when the daemon started: sync only
    // what is written from now on. Backfilling its whole history for every such chat at once
    // after an upgrade is what spiked backend load; the tracked session starts at the cutoff.
    const baselineCutoffMs = discovered.createdAt < this.startedAt ? this.startedAt : undefined;

    const session = this.buildNewSession(discovered, attribution, baselineCutoffMs);
    await this.sessionStore.saveSession(session);
    try {
      await this.metrics.sendSessionStartMetric(session, discovered);
    } catch (error) {
      // ponytail: the start metric is not re-sent; the session's end metric carries it
      logger.warn('[desktop-telemetry] Session START metric failed', {
        sessionId: session.sessionId,
        externalSessionId: discovered.externalSessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return session;
  }

  /**
   * The known record re-tracked under its reconcile lock: undefined while another process holds the lock past
   * {@link DESKTOP_REOPEN_LOCK_BUDGET_MS}, null when the record is gone or of another CodeMie host, `idle` when it is
   * `completed` with no newer activity (both left untouched).
   */
  private async retrackUnderLock(
    knownSessionId: string,
    discovered: LocalTelemetryDiscoveredSession
  ): Promise<Session | 'idle' | undefined | null> {
    // The wait blocks the rest of this poll and isPolling skips the polls due meanwhile;
    // lastPollAt is held back so the next poll re-reads this window
    const lock = await acquirePidLock(reconcileLockPath(knownSessionId), {
      mode: 'wait',
      budgetMs: DESKTOP_REOPEN_LOCK_BUDGET_MS
    });
    if (!lock) {
      logger.warn('[desktop-telemetry] Session record still locked; retried at the next poll', {
        sessionId: knownSessionId,
        externalSessionId: discovered.externalSessionId,
      });
      return undefined;
    }
    try {
      // Read under the lock: a delivery or finalization that held it may have changed or renamed the record
      const existing = await this.sessionStore.loadSession(knownSessionId);
      if (existing && isForeignRecord(existing, this.metrics.credentialsUrl)) {
        logger.info('[desktop-telemetry] Record of another CodeMie host; a new record for this host', {
          sessionId: knownSessionId,
          host: hostOf(existing.codemieUrl),
        });
        return null;
      }
      return existing ? await this.retrackSession(existing, discovered) : null;
    } finally {
      await lock.release();
    }
  }

  /** A new record of a discovered session, owned by this daemon. */
  private buildNewSession(
    discovered: LocalTelemetryDiscoveredSession,
    [gitBranch, repository, project]: Attribution,
    baselineCutoffMs: number | undefined
  ): Session {
    return {
      sessionId: randomUUID(),
      agentName: this.config.clientType,
      provider: this.config.provider,
      codemieUrl: this.metrics.credentialsUrl,
      startTime: baselineCutoffMs ?? discovered.createdAt,
      workingDirectory: discovered.workingDirectory,
      gitBranch: gitBranch || undefined,
      repository: repository || undefined,
      project: project || undefined,
      status: 'active',
      activeDurationMs: 0,
      ...daemonOwner(),
      correlation: {
        status: 'matched',
        agentSessionId: discovered.agentSessionId,
        agentSessionFile: discovered.transcriptPath,
        retryCount: 0
      },
      runtimeCheckpoint: {
        externalSessionId: discovered.externalSessionId,
        transcriptPath: discovered.transcriptPath,
        lastDiscoveredAt: Date.now(),
        lastSeenActivityAt: discovered.updatedAt,
        ...(baselineCutoffMs !== undefined && { baselineCutoffMs })
      }
    };
  }

  /**
   * Re-tracks a known record; the caller holds its reconcile lock. A `completed` one with newer activity is reopened: its
   * `completed_*` set moved back to the live names, its end and delivery state cleared so the resumed
   * stretch gets its own end metric (`startTime` kept). Its folder follows Desktop's: a switched transcript
   * or working directory is taken over, with the branch, repository and project of the new directory.
   */
  private async retrackSession(existing: Session, discovered: LocalTelemetryDiscoveredSession): Promise<Session | 'idle'> {
    if (existing.status === 'completed') {
      // Finalized idle, it stays indexed and in a held-back discovery window: reopened with no newer activity it ends again this poll
      if (!hasActivityAfter(existing, discovered.updatedAt)) return 'idle';
      await this.reopenCompleted(existing, discovered);
    }
    Object.assign(existing, daemonOwner());
    // A record written before the field existed is this host's from the moment this daemon owns it
    existing.codemieUrl ??= this.metrics.credentialsUrl;

    if (discovered.transcriptPath !== existing.correlation.agentSessionFile) {
      existing.correlation.agentSessionFile = discovered.transcriptPath;
    }
    await this.followFolder(existing, discovered.workingDirectory);

    setRuntimeCheckpoint(existing, {
      // Keep fields owned by other steps, e.g. a baseline marker not yet applied after a crash.
      ...existing.runtimeCheckpoint,
      externalSessionId: discovered.externalSessionId,
      transcriptPath: discovered.transcriptPath,
      lastDiscoveredAt: Date.now(),
      lastSeenActivityAt: discovered.updatedAt
    });
    await this.sessionStore.saveSession(existing);
    return existing;
  }

  private async followFolder(existing: Session, workingDirectory: string): Promise<void> {
    if (workingDirectory === existing.workingDirectory) return;
    // ponytail: the start metric and the deltas sent before the switch keep the previous folder's attribution
    const [gitBranch, repository, project] = await detectAttribution(workingDirectory, this.config.profile);
    logger.info('[desktop-telemetry] Session switched folder', {
      sessionId: existing.sessionId, from: existing.workingDirectory, to: workingDirectory, gitBranch, repository, project
    });
    existing.workingDirectory = workingDirectory;
    existing.gitBranch = gitBranch || undefined;
    existing.repository = repository || undefined;
    existing.project = project || undefined;
  }

  /** Moves a `completed` record's set back to its live names and clears its end and delivery state. */
  private async reopenCompleted(existing: Session, discovered: LocalTelemetryDiscoveredSession): Promise<void> {
    logger.info('[desktop-telemetry] Reopening completed session — activity resumed', {
      sessionId: existing.sessionId,
      externalSessionId: discovered.externalSessionId,
    });
    await restoreCompletedFiles(existing.sessionId);
    // An ownerless completed record is either a pre-upgrade one, whose daemon sent its end metric without recording it,
    // or a legacy one closed locally with nothing sent — either way its earlier stretch is not reported again
    const endMetricLeft = existing.ownerPid === undefined
      || existing.endMetricSentAt !== undefined
      || existing.endMetricSkipped !== undefined;
    existing.status = 'active';
    delete existing.endTime;
    delete existing.reason;
    delete existing.endMetricSentAt;
    delete existing.endMetricSkipped;
    delete existing.deliveryAttempts;
    delete existing.finalizeAttempts;
    delete existing.droppedAt;
    delete existing.droppedReason;
    delete existing.deliveryFailingSince;
    delete existing.deliveryRealAttempts;
    // ponytail: the stretch start lags its first activity by up to one poll interval (and the reopen lock wait), and when
    // the previous stretch's end metric never left, the next end metric covers that stretch, the gap and the new one;
    // delivering the pending end metric at the reopen would make it exact
    if (endMetricLeft) {
      existing.stretchStartTime = discovered.updatedAt;
    }
  }

  /**
   * Finalizes a tracked session under its reconcile lock (waited for); a record already `completed` is left
   * as it is. Throws only when the lock stays held or the record cannot be saved — a failed delivery is
   * logged and left for a later attempt.
   */
  private async finalizeSession(sessionId: string, reason: string, trackedActivityAt?: number): Promise<void> {
    const lock = await acquirePidLock(reconcileLockPath(sessionId), { mode: 'wait' });
    if (!lock) {
      throw new ReconcileLockHeldError(sessionId);
    }
    try {
      const session = await this.sessionStore.loadSession(sessionId);
      if (!session || session.status === 'completed') {
        return;
      }
      await this.delivery.finalizeLocked(session, reason, trackedActivityAt);
    } finally {
      await lock.release();
    }
  }
}
