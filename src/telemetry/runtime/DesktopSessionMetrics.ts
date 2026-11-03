import type { SessionStore } from '@/agents/core/session/SessionStore.js';
import type { ProcessingContext } from '@/agents/core/session/BaseProcessor.js';
import type { Session } from '@/agents/core/session/types.js';
import { analyticsAuthMarkedInvalid } from '@/agents/core/session/stale-session-reconciliation.js';
import { MetricsSender } from '@/providers/plugins/sso/index.js';
import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import type {
  DesktopTelemetryRuntimeConfig,
  LocalTelemetryDiscoveredSession
} from '@/telemetry/runtime/types.js';
import { desktopEndTime } from '@/telemetry/runtime/desktop-session.js';
import { logger } from '@/utils/logger.js';

/** The processing context and the start / end metrics of a Desktop session. */
export class DesktopSessionMetrics {
  constructor(
    private readonly config: DesktopTelemetryRuntimeConfig,
    private readonly sessionStore: SessionStore
  ) {}

  /** This daemon's CodeMie host: the URL its cookies are stored under and its records are stamped with. */
  get credentialsUrl(): string {
    return this.config.syncCodeMieUrl || this.config.targetApiUrl;
  }

  /**
   * The daemon holds the cookies a delivery would carry and the server has not rejected them; without
   * them a delivery makes no request and spends no attempt.
   */
  async canDeliver(): Promise<boolean> {
    const urls = [this.credentialsUrl, this.config.syncApiUrl || this.config.targetApiUrl, this.config.targetApiUrl];
    return !(await analyticsAuthMarkedInvalid(urls)) && (await this.loadCookies()) !== '';
  }

  /** `abortSignal` marks the requests of one delivery attempt, so a rejection of its credentials is told apart. */
  async buildProcessingContext(
    session: Session,
    discovered?: LocalTelemetryDiscoveredSession,
    abortSignal?: AbortSignal
  ): Promise<ProcessingContext> {
    return {
      apiBaseUrl: this.config.syncApiUrl || this.config.targetApiUrl,
      cookies: await this.loadCookies(),
      clientType: this.config.clientType,
      version: this.config.version,
      dryRun: false,
      sessionId: session.sessionId,
      agentSessionId: discovered?.agentSessionId || session.correlation.agentSessionId,
      agentSessionFile: discovered?.transcriptPath || session.correlation.agentSessionFile,
      ...(abortSignal && { abortSignal })
    };
  }

  private async loadCookies(): Promise<string> {
    let cookies = '';
    const credentialsUrl = this.credentialsUrl;

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
    return cookies;
  }

  async sendSessionStartMetric(
    session: Session,
    discovered: LocalTelemetryDiscoveredSession
  ): Promise<void> {
    const context = await this.buildProcessingContext(session, discovered);
    if (!context.cookies) {
      return;
    }

    logger.info('[desktop-telemetry] Sending session START metric', {
      agentSessionId: discovered.agentSessionId,
      repository: session.repository,
      gitBranch: session.gitBranch,
      workingDirectory: session.workingDirectory,
      apiBaseUrl: context.apiBaseUrl,
      hasCookies: !!context.cookies,
    });

    await this.createSender(context).sendSessionStart(
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

  /** Sends the end metric once: never after `endMetricSentAt`, which it sets. Without credentials it is not sent. */
  async sendSessionEndMetric(session: Session, abortSignal?: AbortSignal): Promise<void> {
    if (session.endMetricSentAt !== undefined || session.endMetricSkipped !== undefined) {
      return;
    }
    const context = await this.buildProcessingContext(session, undefined, abortSignal);
    if (!context.cookies) {
      logger.warn('[desktop-telemetry] No SSO credentials; END metric kept for a later attempt', {
        sessionId: session.sessionId
      });
      return;
    }

    logger.info('[desktop-telemetry] Sending session END metric', {
      agentSessionId: session.correlation.agentSessionId || session.sessionId,
      repository: session.repository,
      gitBranch: session.gitBranch,
      reason: session.reason,
      apiBaseUrl: context.apiBaseUrl,
    });

    // One end for the duration and end_time
    const endTime = session.endTime ?? desktopEndTime(session);
    const stretchStart = session.stretchStartTime ?? session.startTime;
    await this.createSender(context).sendSessionEnd(
      {
        sessionId: session.correlation.agentSessionId || session.sessionId,
        agentName: this.config.clientType,
        provider: this.config.provider,
        project: session.project,
        repository: session.repository,
        startTime: stretchStart,
        workingDirectory: session.workingDirectory
      },
      session.workingDirectory,
      { status: 'completed', reason: session.reason || 'desktop-session-complete' },
      Math.max(0, endTime - stretchStart),
      undefined,
      session.activeDurationMs,
      endTime
    );
    // ponytail: a process cut between the server's 200 and this save sends the end metric once more
    const latest = (await this.sessionStore.loadSession(session.sessionId)) ?? session;
    await this.sessionStore.saveSession({ ...latest, endMetricSentAt: Date.now() });
  }

  private createSender(context: ProcessingContext): MetricsSender {
    return new MetricsSender({
      baseUrl: context.apiBaseUrl,
      cookies: context.cookies,
      version: this.config.version,
      clientType: this.config.clientType,
      retryAttempts: 2,
      timeout: 10000,
      abortSignal: context.abortSignal
    });
  }
}
