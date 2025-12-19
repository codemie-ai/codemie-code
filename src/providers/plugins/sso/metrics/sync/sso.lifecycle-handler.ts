/**
 * SSO Metrics Lifecycle Handler
 *
 * SSO-specific service for sending session lifecycle metrics.
 * Uses SSO authentication cookies to send metrics to CodeMie API.
 *
 * Used by agent lifecycle hooks to track:
 * - Session start (with status: started/failed)
 * - Session end (with status: completed/failed/interrupted)
 *
 * IMPORTANT: This is an SSO provider capability.
 * Only works with ai-run-sso provider which provides authentication cookies.
 */

import { MetricsSender, SessionStartStatus, SessionEndStatus, SessionError } from './sso.metrics-sender.js';
import { logger } from '../../../../../utils/logger.js';

export interface SessionMetadata {
  sessionId: string;
  agentName: string;
  provider: string;
  project?: string;
  llm_model?: string;
  startTime: number;
  workingDirectory: string;
}

export interface MetricsLifecycleConfig {
  baseUrl: string;
  cookies: string;
  version?: string;
  clientType?: string;
  dryRun?: boolean;
}

/**
 * Lifecycle handler for session metrics
 * Decoupled from agent adapter - can be used anywhere
 */
export class MetricsLifecycleHandler {
  private sender: MetricsSender;
  private sessionMetadata: SessionMetadata | null = null;

  constructor(config: MetricsLifecycleConfig) {
    this.sender = new MetricsSender({
      baseUrl: config.baseUrl,
      cookies: config.cookies,
      timeout: 10000,
      retryAttempts: 2,
      version: config.version,
      clientType: config.clientType,
      dryRun: config.dryRun
    });
  }

  /**
   * Send session start metric
   * @param metadata - Session metadata
   * @param status - Start status (started/failed)
   * @param error - Optional error (required if status=failed)
   */
  async sendSessionStart(
    metadata: SessionMetadata,
    status: SessionStartStatus = 'started',
    error?: SessionError
  ): Promise<void> {
    // Store metadata for session end
    this.sessionMetadata = metadata;

    try {
      await this.sender.sendSessionStart(
        {
          sessionId: metadata.sessionId,
          agentName: metadata.agentName,
          provider: metadata.provider,
          project: metadata.project,
          model: metadata.llm_model,
          startTime: metadata.startTime,
          workingDirectory: metadata.workingDirectory
        },
        metadata.workingDirectory,
        status,
        error
      );

      logger.info('[MetricsLifecycleHandler] Session start metric sent successfully', { status });
    } catch (sendError) {
      const errorMessage = sendError instanceof Error ? sendError.message : String(sendError);
      logger.warn('[MetricsLifecycleHandler] Failed to send session start:', errorMessage);

      // If initial send failed, try to send failed metric
      if (status === 'started') {
        try {
          await this.sender.sendSessionStart(
            {
              sessionId: metadata.sessionId,
              agentName: metadata.agentName,
              provider: metadata.provider,
              project: metadata.project,
              model: metadata.llm_model,
              startTime: metadata.startTime,
              workingDirectory: metadata.workingDirectory
            },
            metadata.workingDirectory,
            'failed',
            {
              type: 'metrics_error',
              message: sendError instanceof Error ? sendError.message : String(sendError),
              code: (sendError as any).code
            }
          );
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          logger.warn('[MetricsLifecycleHandler] Failed to send fallback metric:', fallbackMessage);
        }
      }
    }
  }

  /**
   * Send session end metric
   * @param exitCode - Process exit code
   */
  async sendSessionEnd(exitCode: number): Promise<void> {
    if (!this.sessionMetadata) {
      logger.debug('[MetricsLifecycleHandler] No session metadata - skipping session end');
      return;
    }

    try {
      // Calculate duration
      const durationMs = Date.now() - this.sessionMetadata.startTime;

      // Determine status from exit code
      const status: SessionEndStatus =
        exitCode === 0 ? 'completed' :
        exitCode === 130 || exitCode === 143 ? 'interrupted' : // SIGINT/SIGTERM
        'failed';

      await this.sender.sendSessionEnd(
        {
          sessionId: this.sessionMetadata.sessionId,
          agentName: this.sessionMetadata.agentName,
          provider: this.sessionMetadata.provider,
          project: this.sessionMetadata.project,
          model: this.sessionMetadata.llm_model,
          startTime: this.sessionMetadata.startTime,
          workingDirectory: this.sessionMetadata.workingDirectory
        },
        this.sessionMetadata.workingDirectory,
        status,
        durationMs,
        status === 'failed' ? {
          type: 'agent_exit',
          message: `Agent exited with code ${exitCode}`,
          code: String(exitCode)
        } : undefined
      );

      logger.info('[MetricsLifecycleHandler] Session end metric sent successfully', { status, durationMs });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('[MetricsLifecycleHandler] Failed to send session end:', errorMessage);
    }
  }
}

/**
 * Factory function to create lifecycle handler for SSO provider
 * Loads credentials from SSO auth system
 *
 * @param ssoUrl - Original SSO URL for credential lookup (e.g., https://codemie.lab.epam.com)
 * @param apiUrl - API URL for sending requests (e.g., http://localhost:PORT - proxy URL with cookie injection)
 * @param version - CLI version
 * @param clientType - Client type identifier
 */
export async function createSSOLifecycleHandler(
  ssoUrl: string,
  apiUrl: string,
  version?: string,
  clientType?: string
): Promise<MetricsLifecycleHandler | null> {
  try {
    logger.info(`[MetricsLifecycleHandler] Creating handler (ssoUrl=${ssoUrl}, apiUrl=${apiUrl})`);

    const { CodeMieSSO } = await import('../../sso.auth.js');
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(ssoUrl);

    if (!credentials || !credentials.cookies) {
      logger.info(`[MetricsLifecycleHandler] No SSO credentials found for ${ssoUrl}`);
      return null;
    }

    logger.info('[MetricsLifecycleHandler] SSO credentials found, building handler...');

    // Build cookie header
    const cookieHeader = Object.entries(credentials.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');

    const handler = new MetricsLifecycleHandler({
      baseUrl: apiUrl, // Use proxy URL for API requests (cookies injected by proxy)
      cookies: cookieHeader,
      version,
      clientType
    });

    logger.info('[MetricsLifecycleHandler] Handler created successfully');
    return handler;
  } catch (error) {
    logger.error('[MetricsLifecycleHandler] Failed to create SSO handler:', error);
    return null;
  }
}
