import { randomUUID } from 'crypto';
import { stat } from 'fs/promises';
import { SessionStore } from '@/agents/core/session/SessionStore.js';
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
  daemonOwner,
  isSameFingerprint,
  type TrackedSession,
  type TranscriptFingerprint
} from '@/telemetry/runtime/desktop-session.js';
import { ReconcileLockHeldError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { detectGitBranch, detectGitRemoteRepo } from '@/utils/processes.js';
import { acquirePidLock } from '@/utils/pid-lock.js';
import { ConfigLoader } from '@/utils/config.js';

type Attribution = [string | undefined, string | undefined, string | undefined];

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
  private startupPass?: Promise<void>;
  private redeliveryPass?: Promise<void>;

  constructor(
    private readonly adapter: LocalTelemetryAdapter,
    private readonly config: DesktopTelemetryRuntimeConfig
  ) {
    this.metrics = new DesktopSessionMetrics(config, this.sessionStore);
    this.delivery = new DesktopSessionDelivery(config, this.sessionStore, new SessionSyncer(), adapter, this.metrics);
  }

  async start(): Promise<void> {
    // Fire-and-forget: records a previous daemon left are finalized and delivered while polling starts
    this.startupPass = this.delivery.reconcileRecords(true).catch((error) => {
      logger.error('[desktop-telemetry] Start-up scan failed:', error);
    });
    await this.poll().catch((error) => {
      logger.error('[desktop-telemetry] Poll failed:', error);
    });
    this.timer = setInterval(() => {
      this.poll().catch((error) => {
        logger.error('[desktop-telemetry] Poll failed:', error);
      });
    }, this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
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
      this.knownSessionIds ??= await this.sessionStore.indexSessionsByExternalId(this.config.clientType);
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

      await this.finalizeInactive(now);
      this.startRedeliveryIfDue(now);
    } finally {
      this.lastPollAt = now;
      this.isPolling = false;
    }
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

  /** Starts a re-delivery pass every {@link DESKTOP_REDELIVERY_INTERVAL_MS} unless one is running. */
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
    const transcript = await this.readTranscriptFingerprint(discovered.transcriptPath);

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
    if (!session) {
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

  private async readTranscriptFingerprint(transcriptPath: string): Promise<TranscriptFingerprint | undefined> {
    try {
      const stats = await stat(transcriptPath);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch (error) {
      // Unknown fingerprint never matches, so the session is processed as before.
      logger.debug('[desktop-telemetry] Failed to stat transcript', {
        transcriptPath,
        error: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  /**
   * The record of a discovered session: the known one re-tracked under its reconcile lock, else a new one.
   * Undefined when the known record's lock stays held past {@link DESKTOP_REOPEN_LOCK_BUDGET_MS}.
   */
  private async ensureSession(
    discovered: LocalTelemetryDiscoveredSession,
    knownSessionId?: string
  ): Promise<Session | undefined> {
    if (knownSessionId) {
      const retracked = await this.retrackUnderLock(knownSessionId, discovered);
      if (retracked !== null) {
        return retracked;
      }
    }

    const attribution = await this.detectAttribution(discovered.workingDirectory);
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
   * {@link DESKTOP_REOPEN_LOCK_BUDGET_MS}, null when the record is gone.
   */
  private async retrackUnderLock(
    knownSessionId: string,
    discovered: LocalTelemetryDiscoveredSession
  ): Promise<Session | undefined | null> {
    // ponytail: the wait blocks the rest of this poll and isPolling skips the polls due meanwhile;
    // the discovery window (lastPollAt − pollIntervalMs) covers the gap
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
   * Re-tracks a known record; the caller holds its reconcile lock. A `completed` one is reopened: its
   * `completed_*` set moved back to the live names, its end and delivery state cleared so the resumed
   * stretch gets its own end metric (`startTime` kept). Its folder follows Desktop's: a switched transcript
   * or working directory is taken over, with the branch, repository and project of the new directory.
   */
  private async retrackSession(existing: Session, discovered: LocalTelemetryDiscoveredSession): Promise<Session> {
    if (existing.status === 'completed') {
      await this.reopenCompleted(existing, discovered);
    }
    Object.assign(existing, daemonOwner());

    if (discovered.transcriptPath !== existing.correlation.agentSessionFile) {
      existing.correlation.agentSessionFile = discovered.transcriptPath;
    }
    if (discovered.workingDirectory !== existing.workingDirectory) {
      // ponytail: the start metric and the deltas sent before the switch keep the previous folder's attribution
      const [gitBranch, repository, project] = await this.detectAttribution(discovered.workingDirectory);
      logger.info('[desktop-telemetry] Session switched folder', {
        sessionId: existing.sessionId,
        from: existing.workingDirectory,
        to: discovered.workingDirectory,
        gitBranch,
        repository,
        project,
      });
      existing.workingDirectory = discovered.workingDirectory;
      existing.gitBranch = gitBranch || undefined;
      existing.repository = repository || undefined;
      existing.project = project || undefined;
    }

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

  /** Moves a `completed` record's set back to its live names and clears its end and delivery state. */
  private async reopenCompleted(existing: Session, discovered: LocalTelemetryDiscoveredSession): Promise<void> {
    logger.info('[desktop-telemetry] Reopening completed session — activity resumed', {
      sessionId: existing.sessionId,
      externalSessionId: discovered.externalSessionId,
    });
    await restoreCompletedFiles(existing.sessionId);
    const endMetricLeft = existing.endMetricSentAt !== undefined || existing.endMetricSkipped !== undefined;
    existing.status = 'active';
    delete existing.endTime;
    delete existing.reason;
    delete existing.endMetricSentAt;
    delete existing.endMetricSkipped;
    delete existing.deliveryAttempts;
    delete existing.finalizeAttempts;
    delete existing.droppedAt;
    // ponytail: the stretch start lags its first activity by up to one poll interval (and the reopen lock wait), and when
    // the previous stretch's end metric never left, the next end metric covers that stretch, the gap and the new one;
    // delivering the pending end metric at the reopen would make it exact
    if (endMetricLeft) {
      existing.stretchStartTime = discovered.updatedAt;
    }
  }

  private detectAttribution(workingDirectory: string): Promise<Attribution> {
    return Promise.all([
      detectGitBranch(workingDirectory),
      detectGitRemoteRepo(workingDirectory),
      ConfigLoader.load(workingDirectory)
        .then(c => c.codeMieProject ?? undefined)
        .catch(() => undefined)
    ]);
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
