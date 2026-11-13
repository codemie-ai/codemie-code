import { logger } from '@/utils/logger.js';
import type { CookieAuth } from '@/providers/plugins/sso/session/cookie-auth.js';
import type { SessionStore } from '@/agents/core/session/SessionStore.js';
import type { Session } from '@/agents/core/session/types.js';
import type { MetricsSender } from '@/providers/plugins/sso/session/processors/metrics/metrics-api-client.js';
import type { HookProcessingConfig } from '../hook.js';
import { configSendPathApiUrl, getConfigValue } from './config-value.js';
import type { SessionEndOptions } from './session-end-options.js';
import { loadAnalyticsCookies } from './analytics-cookies.js';
import { noteAwaitingDestination, type RequestOutcome } from '@/providers/plugins/sso/session/bounded-request.js';
import { stampRejection } from '@/agents/core/session/delivery-budget.js';

/** Saves the end metric's outcome on the latest copy of the record. */
async function markEndMetric(
  sessionStore: SessionStore,
  sessionId: string,
  outcome: { endMetricSentAt: number } | { endMetricSkipped: string; legacyMetricsWithheld?: string }
): Promise<void> {
  const latest = await sessionStore.loadSession(sessionId);
  if (latest) await sessionStore.saveSession({ ...latest, ...outcome });
}

/**
 * Marks an end metric the server refused for good (a JSON 400/422) as terminal: it is never re-sent, and the drop is
 * stamped (an earlier one stays) so the exit notice reports it even when the record leaves the queue in this delivery.
 */
export async function markEndMetricRejected(sessionStore: SessionStore, sessionId: string): Promise<void> {
  const latest = await sessionStore.loadSession(sessionId);
  if (!latest) return;
  await sessionStore.saveSession(stampRejection({ ...latest, endMetricSkipped: 'rejected' }, Date.now()));
}

/**
 * The start metric a transient gate verdict withheld at SessionStart, sent ahead of the end metric so the backend
 * never sees a `completed` session without its `started`. Cleared on the record once accepted.
 */
async function sendDeferredStartMetric(
  sender: MetricsSender,
  sessionStore: SessionStore,
  session: Session,
  agentSessionId: string,
  meta: { agentName: string; provider?: string; project?: string; model?: string }
): Promise<void> {
  await sender.sendSessionStart(
    {
      sessionId: agentSessionId,
      agentName: meta.agentName,
      provider: meta.provider || 'unknown',
      project: meta.project,
      model: meta.model,
      startTime: session.startTime,
      workingDirectory: session.workingDirectory,
      ...(session.repository && { repository: session.repository })
    },
    session.workingDirectory,
    { status: 'started', reason: session.startMetricDeferred }
  );
  const latest = await sessionStore.loadSession(session.sessionId);
  if (latest) {
    const { startMetricDeferred: _sent, ...rest } = latest;
    await sessionStore.saveSession(rest);
  }
}

/**
 * The cookies of the end metric: the config's, else the stored SSO credentials. Undefined
 * without credentials: nothing is sent and no delivery attempt is spent — the record waits for a
 * launch that has them.
 */
export async function endMetricCookieAuth(
  ssoUrl: string,
  config: HookProcessingConfig | undefined
): Promise<CookieAuth | undefined> {
  const auth = await loadAnalyticsCookies('[hook:SessionEnd]', ssoUrl, config);
  if (!auth.cookies) {
    logger.info(
      auth.readTimedOut
        ? `[hook:SessionEnd] The credential store did not answer in time for ${ssoUrl}`
        : `[hook:SessionEnd] No SSO credentials found for ${ssoUrl}`
    );
    return undefined;
  }
  return auth;
}

/**
 * Helper: Send session end metrics to CodeMie backend
 * Works for providers that have CodeMie analytics authentication configured
 *
 * The result is kept on the record: a sent metric sets `endMetricSentAt` (never sent again),
 * one that does not apply sets `endMetricSkipped`; a failed send sets neither, so a later
 * run re-delivers it. Inside a hook process it is one request with no retry, stopped by the
 * hook's abort; in-process callers retry within their deadline.
 *
 * @param sessionId - The CodeMie session ID (for file operations)
 * @param agentSessionId - The agent's session ID (for API)
 * @param reason - The session end reason
 * @param config - Optional configuration object (if not provided, reads from environment variables)
 * @param options - The SessionEnd's bounds and mode
 */
export async function sendSessionEndMetrics(
  sessionId: string,
  agentSessionId: string,
  reason: string | undefined,
  config: HookProcessingConfig | undefined,
  options: SessionEndOptions
): Promise<void> {
  let sessionStore: SessionStore | undefined;
  try {
    // Load session to get start / end time
    const { SessionStore } = await import('../../../agents/core/session/SessionStore.js');
    sessionStore = new SessionStore();
    const session = await sessionStore.loadSession(sessionId);

    if (!session) {
      logger.warn(`[hook:SessionEnd] Session not found for metrics: ${sessionId}`);
      return;
    }
    if (session.endMetricSentAt !== undefined || session.endMetricSkipped !== undefined) {
      logger.debug(`[hook:SessionEnd] End metric already ${session.endMetricSentAt !== undefined ? 'sent' : 'skipped'} for ${sessionId}`);
      return;
    }

    // Get required configuration values
    const agentName = getConfigValue('CODEMIE_AGENT', config);
    const provider = getConfigValue('CODEMIE_PROVIDER', config);
    const ssoUrl = getConfigValue('CODEMIE_URL', config);
    const apiUrl = configSendPathApiUrl(config);
    const cliVersion = getConfigValue('CODEMIE_CLI_VERSION', config);
    const model = getConfigValue('CODEMIE_MODEL', config);
    const project = getConfigValue('CODEMIE_PROJECT', config);

    if (!agentName || !ssoUrl) {
      logger.debug('[hook:SessionEnd] Missing required config for metrics');
      await markEndMetric(sessionStore, sessionId, { endMetricSkipped: 'no-analytics-config' });
      return;
    }
    if (!apiUrl) {
      logger.debug('[hook:SessionEnd] No send path (no sync API URL, no started proxy): end metric not sent');
      await markEndMetric(sessionStore, sessionId, { endMetricSkipped: 'no-send-path' });
      return;
    }

    const { isExternalOrigin } = await import('../../../agents/core/session/session-origin-audit.js');
    if (isExternalOrigin(session)) {
      logger.debug('[hook:SessionEnd] Skipping end metrics for external-resume session');
      await markEndMetric(sessionStore, sessionId, { endMetricSkipped: 'external-resume' });
      return;
    }

    const { awaitsDestination, legacyMetricsVerdict } = await import('../../../agents/core/session/legacy-metrics-gate.js');
    const verdict = await legacyMetricsVerdict(session);
    if (!verdict.publish) {
      logger.debug(`[hook:SessionEnd] End metric withheld: ${verdict.reason}`);
      // Reconciliation does not count this attempt: the record waits for the backend's answer, not for a retry
      if (awaitsDestination(verdict)) noteAwaitingDestination(options.abortSignal);
      // A transient verdict is not persisted: the end metric stays unmarked and delivery retries it
      if (!('transient' in verdict)) {
        await markEndMetric(sessionStore, sessionId, { endMetricSkipped: verdict.reason, legacyMetricsWithheld: verdict.reason });
      }
      return;
    }

    // One end for the record, the metric's duration and its end_time
    const endTime = session.endTime ?? Date.now();
    const wallClockDurationMs = endTime - session.startTime;
    const activeDurationMs = session.activeDurationMs || undefined;

    // Build status object with reason from event
    // Status is "completed" for normal session endings, with reason from Claude (e.g., "exit", "logout")
    const status = {
      status: 'completed' as const,
      reason
    };

    const cookieAuth = await endMetricCookieAuth(ssoUrl, config);
    if (!cookieAuth) return;

    // Use MetricsSender to send session end metric
    const { MetricsSender } = await import(
      '../../../providers/plugins/sso/index.js'
    );

    const clientType = getConfigValue('CODEMIE_CLIENT_TYPE', config) || 'codemie-cli';

    const sender = new MetricsSender({
      baseUrl: apiUrl,
      cookies: cookieAuth.cookies,
      credentialsSuperseded: cookieAuth.credentialsSuperseded,
      timeout: 10000,
      retryAttempts: options.hookProcess ? 0 : 2,
      version: cliVersion,
      clientType,
      deadlineMs: options.deadlineMs,
      abortSignal: options.abortSignal
    });

    if (session.startMetricDeferred !== undefined) {
      await sendDeferredStartMetric(sender, sessionStore, session, agentSessionId, { agentName, provider, project, model });
    }

    // The id the run's start metric was accepted under, else (none or empty) the agent session id
    await sender.sendSessionEnd(
      {
        sessionId: session.startMetricSessionId || agentSessionId,
        agentName,
        provider: provider || 'unknown',
        project,
        model,
        startTime: session.startTime,
        workingDirectory: session.workingDirectory,
        ...(session.repository && { repository: session.repository }),
        ...(session.gitBranch && { gitBranch: session.gitBranch })
      },
      session.workingDirectory,
      status,
      wallClockDurationMs,
      undefined, // error parameter - undefined for normal termination
      activeDurationMs,
      endTime
    );
    // ponytail: a process cut between the server's 200 and this save sends the end metric once more
    await markEndMetric(sessionStore, sessionId, { endMetricSentAt: Date.now() });

    logger.info('[hook:SessionEnd] Session end metrics sent successfully', {
      status,
      reason,
      wallClockDurationMs,
      activeDurationMs
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`[hook:SessionEnd] Failed to send metrics: ${errorMessage}`);
    // A refusal for good is terminal; any other failure leaves the end metric unmarked for a later run
    if (sessionStore && (error as { outcome?: RequestOutcome } | null)?.outcome === 'rejected') {
      await markEndMetricRejected(sessionStore, sessionId).catch((markError: unknown) => {
        logger.warn(`[hook:SessionEnd] Cannot mark the rejected end metric of ${sessionId}: ${markError instanceof Error ? markError.message : String(markError)}`);
      });
    }
    // Don't throw - metrics failures should not block agent execution
  }
}
