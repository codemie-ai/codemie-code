import { randomUUID } from 'crypto';
import { SessionStore } from '@/agents/core/session/SessionStore.js';
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

interface TrackedSession {
  codemieSessionId: string;
  lastSeenActivityAt: number;
}

export class DesktopTelemetryRuntime {
  private readonly sessionStore = new SessionStore();
  private readonly syncer = new SessionSyncer();
  private readonly trackedSessions = new Map<string, TrackedSession>();
  private readonly startedAt = Date.now();
  private timer?: NodeJS.Timeout;
  private lastPollAt = this.startedAt;
  private isPolling = false;

  constructor(
    private readonly adapter: LocalTelemetryAdapter,
    private readonly config: DesktopTelemetryRuntimeConfig
  ) {}

  async start(): Promise<void> {
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

    for (const tracked of this.trackedSessions.values()) {
      await this.finalizeSession(tracked.codemieSessionId, 'desktop-daemon-stop');
    }
  }

  private async poll(): Promise<void> {
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;
    const now = Date.now();

    try {
      const discoveredSessions = await this.adapter.discoverSessions(this.lastPollAt - this.config.pollIntervalMs);
      for (const discovered of discoveredSessions) {
        if (discovered.createdAt < this.startedAt) {
          continue;
        }

        const session = await this.ensureSession(discovered);
        this.trackedSessions.set(discovered.externalSessionId, {
          codemieSessionId: session.sessionId,
          lastSeenActivityAt: discovered.updatedAt
        });

        await this.processSession(session, discovered);
      }

      for (const [externalSessionId, tracked] of this.trackedSessions) {
        const inactiveForMs = now - tracked.lastSeenActivityAt;
        if (inactiveForMs < this.config.inactivityTimeoutMs) {
          continue;
        }

        await this.finalizeSession(tracked.codemieSessionId, 'desktop-inactive-timeout');
        this.trackedSessions.delete(externalSessionId);
      }
    } finally {
      this.lastPollAt = now;
      this.isPolling = false;
    }
  }

  private async ensureSession(discovered: LocalTelemetryDiscoveredSession): Promise<Session> {
    const existing = await this.sessionStore.findSessionByExternalId(
      this.config.clientType,
      discovered.externalSessionId
    );
    if (existing) {
      setRuntimeCheckpoint(existing, {
        externalSessionId: discovered.externalSessionId,
        transcriptPath: discovered.transcriptPath,
        lastDiscoveredAt: Date.now(),
        lastSeenActivityAt: discovered.updatedAt
      });
      await this.sessionStore.saveSession(existing);
      return existing;
    }

    const [gitBranch, repository] = await Promise.all([
      detectGitBranch(discovered.workingDirectory),
      detectGitRemoteRepo(discovered.workingDirectory)
    ]);

    const session: Session = {
      sessionId: randomUUID(),
      agentName: this.config.clientType,
      provider: this.config.provider,
      startTime: discovered.createdAt,
      workingDirectory: discovered.workingDirectory,
      gitBranch: gitBranch || undefined,
      repository: repository || undefined,
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
        lastSeenActivityAt: discovered.updatedAt
      }
    };

    await this.sessionStore.saveSession(session);
    await this.sendSessionStartMetric(session, discovered);
    return session;
  }

  private async processSession(session: Session, discovered: LocalTelemetryDiscoveredSession): Promise<void> {
    const parsedSession = await this.adapter.parseSession(discovered, session.sessionId);
    const context = await this.buildProcessingContext(session, discovered);
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

  private async finalizeSession(sessionId: string, reason: string): Promise<void> {
    const session = await this.sessionStore.loadSession(sessionId);
    if (!session || session.status === 'completed') {
      return;
    }

    session.status = 'completed';
    session.reason = reason;
    session.endTime = Date.now();
    await this.sessionStore.saveSession(session);

    const externalSessionId = session.runtimeCheckpoint?.externalSessionId;
    if (externalSessionId) {
      try {
        const sinceMs = Math.max(
          0,
          (session.runtimeCheckpoint?.lastSeenActivityAt
            ?? session.runtimeCheckpoint?.lastDiscoveredAt
            ?? session.startTime) - this.config.pollIntervalMs
        );
        const discoveredSessions = await this.adapter.discoverSessions(sinceMs);
        const discovered = discoveredSessions.find(
          candidate => candidate.externalSessionId === externalSessionId
        );

        if (discovered) {
          await this.processSession(session, discovered);
        } else {
          logger.warn('[desktop-telemetry] Failed to rediscover session during finalization', {
            sessionId,
            externalSessionId
          });
        }
      } catch (error) {
        logger.warn('[desktop-telemetry] Final transcript processing failed', {
          sessionId,
          externalSessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const context = await this.buildProcessingContext(session);
    await this.syncer.sync(sessionId, context);
    await this.sendSessionEndMetric(session);
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

    await sender.sendSessionStart(
      {
        sessionId: discovered.agentSessionId,
        agentName: this.config.clientType,
        provider: this.config.provider,
        startTime: session.startTime,
        workingDirectory: session.workingDirectory,
        repository: session.repository,
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

    await sender.sendSessionEnd(
      {
        sessionId: session.correlation.agentSessionId || session.sessionId,
        agentName: this.config.clientType,
        provider: this.config.provider,
        startTime: session.startTime,
        workingDirectory: session.workingDirectory,
        repository: session.repository
      },
      session.workingDirectory,
      { status: 'completed', reason: session.reason || 'desktop-session-complete' },
      Math.max(0, (session.endTime || Date.now()) - session.startTime),
      undefined,
      session.activeDurationMs
    );
  }
}
