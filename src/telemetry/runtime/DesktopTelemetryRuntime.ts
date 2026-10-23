import { randomUUID } from 'crypto';
import { stat } from 'fs/promises';
import { SessionStore } from '@/agents/core/session/SessionStore.js';
import { isSessionStale } from '@/agents/core/session/stale-session-policy.js';
import type { ProcessingContext } from '@/agents/core/session/BaseProcessor.js';
import type { Session } from '@/agents/core/session/types.js';
import { MetricsSender } from '@/providers/plugins/sso/index.js';
import { SessionSyncer } from '@/providers/plugins/sso/session/SessionSyncer.js';
import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import type {
  DesktopTelemetryRuntimeConfig,
  LocalTelemetryAdapter,
  LocalTelemetryDiscoveredSession
} from '@/telemetry/runtime/types.js';
import { setRuntimeCheckpoint } from '@/telemetry/runtime/checkpoints.js';
import { logger } from '@/utils/logger.js';
import { detectGitBranch, detectGitRemoteRepo } from '@/utils/processes.js';
import { ConfigLoader } from '@/utils/config.js';

interface TranscriptFingerprint {
  mtimeMs: number;
  size: number;
}

interface TrackedSession {
  codemieSessionId: string;
  lastSeenActivityAt: number;
  transcript?: TranscriptFingerprint;
}

function isSameFingerprint(
  previous: TranscriptFingerprint | undefined,
  current: TranscriptFingerprint
): boolean {
  return previous !== undefined
    && previous.mtimeMs === current.mtimeMs
    && previous.size === current.size;
}

export class DesktopTelemetryRuntime {
  private readonly sessionStore = new SessionStore();
  private readonly syncer = new SessionSyncer();
  private readonly trackedSessions = new Map<string, TrackedSession>();
  // externalSessionId -> CodeMie session id for every session persisted by this or a previous
  // daemon. Built with one directory scan so polls never rescan ~/.codemie/sessions per session.
  private knownSessionIds?: Map<string, string>;
  private readonly startedAt = Date.now();
  private timer?: NodeJS.Timeout;
  private lastPollAt = this.startedAt;
  private isPolling = false;
  private reconciliationPromise?: Promise<void>;

  constructor(
    private readonly adapter: LocalTelemetryAdapter,
    private readonly config: DesktopTelemetryRuntimeConfig
  ) {}

  async start(): Promise<void> {
    // Fire-and-forget, mirroring BaseAgentAdapter's reconcileStaleSessions call: a daemon
    // restart with a few stranded sessions must not make the caller (proxy-daemon's
    // persistState, gated by the CLI's 5s readiness poll) wait on sync + metric calls that
    // carry their own 10-30s network timeouts. Reconciliation runs to completion in the
    // background; stop() awaits it so shutdown never races an in-flight finalize.
    this.reconciliationPromise = this.reconcilePersistedSessions().catch((error) => {
      logger.warn('[desktop-telemetry] Startup reconciliation failed (non-blocking)', {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    await this.poll();
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

    await this.reconciliationPromise;

    // Final poll to catch sessions whose transcript was written after the last regular poll
    // but before proxy stop (e.g. Code tab sessions where transcript write is async).
    await this.poll().catch((error) => {
      logger.error('[desktop-telemetry] Final poll on stop failed:', error);
    });

    for (const tracked of this.trackedSessions.values()) {
      await this.finalizeSession(tracked.codemieSessionId, 'desktop-daemon-stop');
    }
  }

  async triggerPoll(): Promise<void> {
    await this.poll();
  }


  /**
   * `trackedSessions` is in-memory only, so a hard-killed daemon starts the next run with
   * no memory of sessions it was tracking. poll() only (re)tracks a session once new
   * activity lands after `startedAt` — a session already idle when the daemon died would
   * otherwise never be rediscovered and would stay `active` forever. Seed tracking from
   * disk instead: finalize anything already past the idle timeout immediately, and hand
   * the rest to the normal poll-driven idle check.
   */
  private async reconcilePersistedSessions(): Promise<void> {
    const activeSessions = await this.sessionStore.findActiveSessions(this.config.clientType);
    if (activeSessions.length === 0) {
      return;
    }

    const now = Date.now();
    for (const session of activeSessions) {
      const externalSessionId = session.runtimeCheckpoint?.externalSessionId;
      if (!externalSessionId) {
        continue;
      }

      const lastSeenActivityAt = session.runtimeCheckpoint?.lastSeenActivityAt ?? session.startTime;
      const inactiveForMs = now - lastSeenActivityAt;

      if (
        isSessionStale({
          now,
          lastActivityMs: lastSeenActivityAt,
          inactivityThresholdMs: this.config.inactivityTimeoutMs,
        })
      ) {
        // Reconciliation now runs concurrently with poll() rather than before it, so a
        // session judged stale from the snapshot taken above may have picked up fresh
        // activity in the meantime — poll() tracks it the moment that happens. Finalizing
        // it anyway would stamp a live session completed out from under the user.
        if (this.trackedSessions.has(externalSessionId)) {
          logger.debug('[desktop-telemetry] Skipping stale finalize: session has fresh activity', {
            externalSessionId,
            sessionId: session.sessionId,
          });
          continue;
        }

        logger.info('[desktop-telemetry] Finalizing session stranded by a previous daemon', {
          externalSessionId,
          sessionId: session.sessionId,
          inactiveForMs,
        });
        // One session's finalization (sync, metric send) must never abort the rest, and
        // must never propagate out of start() — a single bad network/SSO blip here would
        // otherwise stop the whole daemon from starting, which is strictly worse than the
        // stale-session gap this method exists to close.
        try {
          await this.finalizeSession(session.sessionId, 'desktop-daemon-restart-stale', lastSeenActivityAt);
        } catch (error) {
          logger.warn('[desktop-telemetry] Failed to finalize stranded session (non-blocking)', {
            externalSessionId,
            sessionId: session.sessionId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        continue;
      }

      this.trackedSessions.set(externalSessionId, {
        codemieSessionId: session.sessionId,
        lastSeenActivityAt
      });
    }
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

        const tracked = this.trackedSessions.get(discovered.externalSessionId);
        // Taken before parsing, so a write that lands mid-processing is picked up next tick.
        const transcript = await this.readTranscriptFingerprint(discovered.transcriptPath);

        // Desktop bumps lastActivityAt without necessarily appending to the transcript.
        // Nothing new to parse or sync, so keep the session alive and skip the work.
        if (tracked && transcript && isSameFingerprint(tracked.transcript, transcript)) {
          tracked.lastSeenActivityAt = Math.max(tracked.lastSeenActivityAt, discovered.updatedAt);
          continue;
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
          tracked?.codemieSessionId ?? this.knownSessionIds.get(discovered.externalSessionId)
        );
        this.knownSessionIds.set(discovered.externalSessionId, session.sessionId);
        const nextTracked: TrackedSession = {
          codemieSessionId: session.sessionId,
          lastSeenActivityAt: discovered.updatedAt,
          transcript: tracked?.transcript
        };
        this.trackedSessions.set(discovered.externalSessionId, nextTracked);

        await this.processSession(session, discovered);
        // Record the fingerprint only once processing succeeded: a failed parse or sync must
        // not mark this transcript state as handled, or the delta would wait for the next write.
        nextTracked.transcript = transcript;
      }

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
        await this.finalizeSession(tracked.codemieSessionId, 'desktop-inactive-timeout', tracked.lastSeenActivityAt);
        this.trackedSessions.delete(externalSessionId);
      }
    } finally {
      this.lastPollAt = now;
      this.isPolling = false;
    }
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

  private async ensureSession(
    discovered: LocalTelemetryDiscoveredSession,
    knownSessionId?: string
  ): Promise<Session> {
    const existing = knownSessionId ? await this.sessionStore.loadSession(knownSessionId) : null;
    if (existing) {
      // A previous daemon stop finalized this session. New activity means the conversation
      // continued, so reopen it — otherwise finalizeSession's completed-status early return
      // would leave the resumed stretch without an end metric or duration.
      if (existing.status === 'completed') {
        logger.info('[desktop-telemetry] Reopening completed session — activity resumed', {
          sessionId: existing.sessionId,
          externalSessionId: discovered.externalSessionId,
        });
        existing.status = 'active';
        delete existing.endTime;
        delete existing.reason;
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

    const [gitBranch, repository, project] = await Promise.all([
      detectGitBranch(discovered.workingDirectory),
      detectGitRemoteRepo(discovered.workingDirectory),
      ConfigLoader.load(discovered.workingDirectory)
        .then(c => c.codeMieProject ?? undefined)
        .catch(() => undefined)
    ]);
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

    const session: Session = {
      sessionId: randomUUID(),
      agentName: this.config.clientType,
      clientType: this.config.clientType,
      provider: this.config.provider,
      startTime: baselineCutoffMs ?? discovered.createdAt,
      workingDirectory: discovered.workingDirectory,
      gitBranch: gitBranch || undefined,
      repository: repository || undefined,
      project: project || undefined,
      status: 'active',
      activeDurationMs: 0,
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

    await this.sessionStore.saveSession(session);
    await this.sendSessionStartMetric(session, discovered);
    return session;
  }

  private async processSession(session: Session, discovered: LocalTelemetryDiscoveredSession): Promise<void> {
    const parsedSession = await this.adapter.parseSession(discovered, session.sessionId);
    const context = await this.buildProcessingContext(session, discovered);

    // Persisted with the session, so a crash before this point still applies it next time.
    const baselineCutoffMs = session.runtimeCheckpoint?.baselineCutoffMs;
    if (baselineCutoffMs !== undefined && this.adapter.applyBaseline) {
      await this.adapter.applyBaseline(parsedSession, baselineCutoffMs, context);
      delete session.runtimeCheckpoint!.baselineCutoffMs;
    }

    const result = await this.adapter.processParsedSession(parsedSession, context);

    if (result.totalRecords > 0) {
      const syncResult = await this.syncer.sync(session.sessionId, context);
      logger.info('[desktop-telemetry] Session synced', {
        sessionId: session.sessionId,
        externalSessionId: discovered.externalSessionId,
        totalRecords: result.totalRecords,
        syncMessage: syncResult.message
      });
    }
  }

  private async finalizeSession(sessionId: string, reason: string, endTime: number = Date.now()): Promise<void> {
    const session = await this.sessionStore.loadSession(sessionId);
    if (!session || session.status === 'completed') {
      return;
    }

    const externalSessionId = session.runtimeCheckpoint?.externalSessionId;
    if (externalSessionId) {
      const sinceMs = Math.max(
        0,
        (session.runtimeCheckpoint?.lastSeenActivityAt
          ?? session.runtimeCheckpoint?.lastDiscoveredAt
          ?? session.startTime) - this.config.pollIntervalMs
      );
      try {
        const discoveredSessions = await this.adapter.discoverSessions(sinceMs);
        const discovered = discoveredSessions.find(
          candidate => candidate.externalSessionId === externalSessionId
        );

        if (!discovered) {
          logger.warn('[desktop-telemetry] Failed to rediscover session during finalization; continuing with persisted state', {
            sessionId,
            externalSessionId
          });
        } else {
          await this.processSession(session, discovered);
        }
      } catch (error) {
        logger.warn('[desktop-telemetry] Final transcript processing failed (non-blocking)', {
          sessionId,
          externalSessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const latestSession = await this.sessionStore.loadSession(sessionId) ?? session;
    const finalizedSession: Session = {
      ...latestSession,
      status: 'completed',
      reason,
      endTime,
    };

    const context = await this.buildProcessingContext(finalizedSession);
    await this.syncer.sync(sessionId, context);
    await this.sendSessionEndMetric(finalizedSession);
    await this.sessionStore.saveSession(finalizedSession);
    logger.info('[desktop-telemetry] Session finalized', {
      sessionId,
      reason,
      repository: finalizedSession.repository,
      gitBranch: finalizedSession.gitBranch,
      status: finalizedSession.status,
    });
  }

  private async buildProcessingContext(
    session: Session,
    discovered?: LocalTelemetryDiscoveredSession
  ): Promise<ProcessingContext> {
    let cookies = '';
    const credentialsUrl = this.config.syncCodeMieUrl || this.config.targetApiUrl;

    try {
      const credentials = await new CodeMieSSO().getStoredCredentials(credentialsUrl);
      if (credentials?.cookies) {
        cookies = Object.entries(credentials.cookies)
          .map(([key, value]) => `${key}=${value}`)
          .join('; ');
      }
    } catch (error) {
      logger.debug('[desktop-telemetry] Failed to load SSO credentials', {
        credentialsUrl,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return {
      apiBaseUrl: this.config.syncApiUrl || this.config.targetApiUrl,
      cookies,
      clientType: this.config.clientType,
      version: this.config.version,
      dryRun: false,
      sessionId: session.sessionId,
      agentSessionId: discovered?.agentSessionId || session.correlation.agentSessionId,
      agentSessionFile: discovered?.transcriptPath || session.correlation.agentSessionFile
    };
  }

  private async sendSessionStartMetric(
    session: Session,
    discovered: LocalTelemetryDiscoveredSession
  ): Promise<void> {
    const context = await this.buildProcessingContext(session, discovered);
    if (!context.cookies) {
      return;
    }

    const sender = new MetricsSender({
      baseUrl: context.apiBaseUrl,
      cookies: context.cookies,
      version: this.config.version,
      clientType: this.config.clientType,
      retryAttempts: 2,
      timeout: 10000
    });

    logger.info('[desktop-telemetry] Sending session START metric', {
      agentSessionId: discovered.agentSessionId,
      repository: session.repository,
      gitBranch: session.gitBranch,
      workingDirectory: session.workingDirectory,
      apiBaseUrl: context.apiBaseUrl,
      hasCookies: !!context.cookies,
    });

    await sender.sendSessionStart(
      {
        sessionId: discovered.agentSessionId,
        agentName: this.config.clientType,
        provider: this.config.provider,
        project: session.project,
        repository: session.repository,
        startTime: session.startTime,
        workingDirectory: session.workingDirectory,
        model: discovered.model
      },
      session.workingDirectory,
      { status: 'started', reason: 'desktop-proxy-detected' }
    );
  }

  private async sendSessionEndMetric(session: Session): Promise<void> {
    const context = await this.buildProcessingContext(session);
    if (!context.cookies) {
      return;
    }

    const sender = new MetricsSender({
      baseUrl: context.apiBaseUrl,
      cookies: context.cookies,
      version: this.config.version,
      clientType: this.config.clientType,
      retryAttempts: 2,
      timeout: 10000
    });

    logger.info('[desktop-telemetry] Sending session END metric', {
      agentSessionId: session.correlation.agentSessionId || session.sessionId,
      repository: session.repository,
      gitBranch: session.gitBranch,
      reason: session.reason,
      apiBaseUrl: context.apiBaseUrl,
    });

    await sender.sendSessionEnd(
      {
        sessionId: session.correlation.agentSessionId || session.sessionId,
        agentName: this.config.clientType,
        provider: this.config.provider,
        project: session.project,
        repository: session.repository,
        startTime: session.startTime,
        workingDirectory: session.workingDirectory
      },
      session.workingDirectory,
      { status: 'completed', reason: session.reason || 'desktop-session-complete' },
      Math.max(0, (session.endTime || Date.now()) - session.startTime),
      undefined,
      session.activeDurationMs
    );
  }
}
