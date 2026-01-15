/**
 * SSO Metrics Sender
 *
 * SSO-specific utility for sending metrics to CodeMie API.
 * Provides high-level methods for different metric types:
 * - Session start metrics
 * - Session end metrics
 * - Aggregated session metrics
 *
 * Used by:
 * - SSO metrics sync proxy plugin (aggregated metrics sync)
 * - BaseAgentAdapter (session lifecycle for ai-run-sso)
 *
 * IMPORTANT: This is an SSO provider capability, not a generic metrics capability.
 * Only works with ai-run-sso provider which provides authentication cookies.
 */

import type { SessionMetric, MetricsApiConfig, MetricsSyncResponse, MetricsApiError } from './metrics-types.js';
import type { Session } from '../../../../../../agents/core/session/types.js';
import { logger } from '../../../../../../utils/logger.js';
import { detectGitBranch } from '../../../../../../utils/processes.js';
import { CODEMIE_ENDPOINTS } from '../../../sso.http-client.js';

/**
 * Low-level HTTP client for sending metrics to CodeMie API
 * Features:
 * - Exponential backoff retry
 * - SSO cookie authentication or apiKey authentication
 * - JSON batch sending
 * - Error classification (retryable vs non-retryable)
 */
class MetricsApiClient {
  private readonly config: Required<MetricsApiConfig>;

  constructor(config: MetricsApiConfig) {
    this.config = {
      baseUrl: config.baseUrl,
      cookies: config.cookies || '',
      apiKey: config.apiKey || '',
      timeout: config.timeout || 30000,
      retryAttempts: config.retryAttempts || 3,
      retryDelays: config.retryDelays || [1000, 2000, 5000],
      version: config.version || process.env.CODEMIE_CLI_VERSION || 'unknown',
      clientType: config.clientType || 'codemie-cli'
    };
  }

  async sendMetric(metric: SessionMetric): Promise<MetricsSyncResponse> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.retryAttempts; attempt++) {
      try {
        if (attempt > 0) {
          const delay = this.config.retryDelays[attempt - 1] || 5000;
          logger.debug(`[MetricsApiClient] Retry attempt ${attempt} after ${delay}ms`);
          await this.sleep(delay);
        }

        return await this.sendRequest(metric);

      } catch (error) {
        lastError = error as Error;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorName = error instanceof Error ? error.name : 'Unknown';
        const statusCode = (error as any).statusCode;

        if (!this.isRetryable(error as Error)) {
          logger.error(`[MetricsApiClient] Non-retryable error [${errorName}]: ${errorMessage}${statusCode ? ` (HTTP ${statusCode})` : ''}`);
          throw error;
        }

        logger.warn(`[MetricsApiClient] Attempt ${attempt + 1} failed [${errorName}]: ${errorMessage}${statusCode ? ` (HTTP ${statusCode})` : ''}`);
      }
    }

    throw new Error(`Failed after ${this.config.retryAttempts} retries: ${lastError?.message}`);
  }

  private async sendRequest(metric: SessionMetric): Promise<MetricsSyncResponse> {
    const url = `${this.config.baseUrl}${CODEMIE_ENDPOINTS.METRICS}`;
    const body = JSON.stringify(metric);

    logger.debug(`[MetricsApiClient] Sending metric to ${url}. Body ${body}`);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `codemie-cli/${this.config.version}`,
      'X-CodeMie-CLI': `codemie-cli/${this.config.version}`,
      'X-CodeMie-Client': this.config.clientType
    };

    if (this.config.apiKey) {
      headers['user-id'] = this.config.apiKey;
    } else if (this.config.cookies) {
      headers['Cookie'] = this.config.cookies;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const data = await response.json() as MetricsSyncResponse | MetricsApiError;

      if (!response.ok) {
        if ('code' in data && 'details' in data) {
          const errorData = data as MetricsApiError;
          let errorMessage = `API returned ${response.status}: ${errorData.message}`;
          if (errorData.details) errorMessage += `\nDetails: ${errorData.details}`;
          if (errorData.help) errorMessage += `\nHelp: ${errorData.help}`;

          const error = new Error(errorMessage);
          (error as any).statusCode = response.status;
          (error as any).response = data;
          throw error;
        }

        const errorMessage = 'message' in data ? data.message : response.statusText;
        const error = new Error(`API returned ${response.status}: ${errorMessage}`);
        (error as any).statusCode = response.status;
        (error as any).response = data;
        throw error;
      }

      const successData = data as MetricsSyncResponse;
      logger.debug(`[MetricsApiClient] Response from ${url}: success=${successData.success}, message="${successData.message}"`);

      if (!successData.success) {
        const error = new Error(`API reported failure: ${successData.message}`);
        (error as any).response = data;
        throw error;
      }

      logger.info(`[MetricsApiClient] Successfully sent metric: ${successData.message}`);
      return successData;

    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error(`Request timeout after ${this.config.timeout}ms`);
      }
      throw error;
    }
  }

  private isRetryable(error: Error): boolean {
    const statusCode = (error as any).statusCode;
    if (!statusCode) return true;  // Network errors
    if (statusCode >= 500 || statusCode === 429) return true;  // Server errors and rate limit
    return false;  // 4xx errors (except 429)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Session start status object with reason
 */
export interface SessionStartStatus {
  status: 'started' | 'failed';
  reason?: string;  // Optional reason (e.g., "startup", error message)
}

/**
 * Session end status object with reason
 */
export interface SessionEndStatus {
  status: 'completed' | 'failed' | 'interrupted';
  reason?: string;  // Optional reason (e.g., "exit", "logout", error message)
}

/**
 * Session lifecycle error
 */
export interface SessionError {
  type: string;      // Error type (e.g., 'spawn_error', 'metrics_error', 'network_error')
  message: string;   // Error message
  code?: string;     // Error code (optional)
}

export interface MetricsSenderOptions {
  baseUrl: string;
  cookies?: string;
  apiKey?: string;    // API key for localhost development (user-id header)
  timeout?: number;
  retryAttempts?: number;
  version?: string;
  clientType?: string;
  dryRun?: boolean;  // Dry-run mode: log metrics without sending
}

/**
 * High-level metrics sender for SSO provider
 * Wraps MetricsApiClient with convenience methods
 */
export class MetricsSender {
  /**
   * Metric name constants
   * - METRIC_SESSION_TOTAL: Session lifecycle events (start, end)
   *   Differentiated by 'status' attribute: started, completed, failed, interrupted
   * - METRIC_USAGE_TOTAL: Aggregated usage metrics (periodic sync)
   *   Contains accumulated token, tool, and file operation metrics
   */
  static readonly METRIC_SESSION_TOTAL = 'codemie_cli_session_total';
  static readonly METRIC_USAGE_TOTAL = 'codemie_cli_usage_total';

  private client: MetricsApiClient;
  private dryRun: boolean;
  private version: string;

  constructor(options: MetricsSenderOptions) {
    this.dryRun = options.dryRun || false;
    this.version = options.version || 'unknown';
    const config: MetricsApiConfig = {
      baseUrl: options.baseUrl,
      cookies: options.cookies,
      apiKey: options.apiKey,
      timeout: options.timeout,
      retryAttempts: options.retryAttempts,
      version: options.version,
      clientType: options.clientType
    };

    this.client = new MetricsApiClient(config);
  }

  /**
   * Send session start metric
   * Called when agent begins execution with ai-run-sso provider
   *
   * @param session - Session metadata (with optional model)
   * @param workingDirectory - Current working directory (for git branch detection)
   * @param status - Session start status object with status and optional reason
   * @param error - Optional error information (required if status=failed)
   */
  async sendSessionStart(
    session: Pick<Session, 'sessionId' | 'agentName' | 'provider' | 'project' | 'startTime' | 'workingDirectory'> & { model?: string },
    workingDirectory: string,
    status: SessionStartStatus = { status: 'started' },
    error?: SessionError
  ): Promise<MetricsSyncResponse> {
    // Detect git branch
    const branch = await detectGitBranch(workingDirectory);

    // Extract repository from working directory
    const repository = this.extractRepository(workingDirectory);

    // Build session start metric with status
    const attributes: any = {
      // Identity
      agent: session.agentName,
      agent_version: this.version,
      llm_model: session.model || 'unknown', // From profile config
      repository,
      session_id: session.sessionId,
      branch: branch || 'unknown',
      ...(session.project && { project: session.project }),

      // Zero metrics (session just started)
      total_user_prompts: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_input_tokens: 0,
      total_cache_creation_tokens: 0,
      total_tool_calls: 0,
      successful_tool_calls: 0,
      failed_tool_calls: 0,
      files_created: 0,
      files_modified: 0,
      files_deleted: 0,
      total_lines_added: 0,
      total_lines_removed: 0,

      // Session metadata
      session_duration_ms: 0,
      had_errors: status.status === 'failed',
      count: 1,

      // Lifecycle status
      status: status.status,
      ...(status.reason && { reason: status.reason })
    };

    // Add error details if session start failed
    if (status.status === 'failed' && error) {
      attributes.errors = {
        [error.type]: [error.code ? `[${error.code}] ${error.message}` : error.message]
      };
    }

    const metric: SessionMetric = {
      name: MetricsSender.METRIC_SESSION_TOTAL,
      attributes
    };

    // Dry-run mode: log without sending
    if (this.dryRun) {
      logger.info('[MetricsSender] [DRY-RUN] Would send session start metric:', {
        endpoint: 'POST /v1/metrics',
        metric: {
          name: metric.name,
          attributes: {
            agent: metric.attributes.agent,
            session_id: metric.attributes.session_id,
            branch: metric.attributes.branch,
            repository: metric.attributes.repository,
            status: status.status,
            reason: status.reason,
            ...(error && { error_type: error.type })
          }
        }
      });

      return { success: true, message: '[DRY-RUN] Session start metric logged' };
    }

    const response = await this.client.sendMetric(metric);

    logger.info(`[MetricsSender] Session start metric sent`, metric);

    return response;
  }

  /**
   * Send session end metric
   * Called when agent process exits
   *
   * @param session - Session metadata (with optional model)
   * @param workingDirectory - Current working directory (for git branch detection)
   * @param status - Session end status object with status and optional reason
   * @param durationMs - Session duration in milliseconds
   * @param error - Optional error information (for failed sessions)
   */
  async sendSessionEnd(
    session: Pick<Session, 'sessionId' | 'agentName' | 'provider' | 'project' | 'startTime' | 'workingDirectory'> & { model?: string },
    workingDirectory: string,
    status: SessionEndStatus,
    durationMs: number,
    error?: SessionError
  ): Promise<MetricsSyncResponse> {
    // Detect git branch
    const branch = await detectGitBranch(workingDirectory);

    // Extract repository from working directory
    const repository = this.extractRepository(workingDirectory);

    // Build session end metric with status
    const attributes: any = {
      // Identity
      agent: session.agentName,
      agent_version: this.version,
      llm_model: session.model || 'unknown',
      repository,
      session_id: session.sessionId,
      branch: branch || 'unknown',
      ...(session.project && { project: session.project }),

      // Zero metrics (detailed metrics come from aggregated usage)
      total_user_prompts: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_input_tokens: 0,
      total_cache_creation_tokens: 0,
      total_tool_calls: 0,
      successful_tool_calls: 0,
      failed_tool_calls: 0,
      files_created: 0,
      files_modified: 0,
      files_deleted: 0,
      total_lines_added: 0,
      total_lines_removed: 0,

      // Session metadata
      session_duration_ms: durationMs,
      had_errors: status.status === 'failed',
      count: 1,

      // Lifecycle status
      status: status.status,
      ...(status.reason && { reason: status.reason })
    };

    // Add error details if session ended with error
    if (status.status === 'failed' && error) {
      attributes.errors = {
        [error.type]: [error.code ? `[${error.code}] ${error.message}` : error.message]
      };
    }

    const metric: SessionMetric = {
      name: MetricsSender.METRIC_SESSION_TOTAL,
      attributes
    };

    // Dry-run mode: log without sending
    if (this.dryRun) {
      logger.info('[MetricsSender] [DRY-RUN] Would send session end metric:', {
        endpoint: 'POST /v1/metrics',
        metric: {
          name: metric.name,
          attributes: {
            agent: metric.attributes.agent,
            session_id: metric.attributes.session_id,
            branch: metric.attributes.branch,
            repository: metric.attributes.repository,
            status: status.status,
            reason: status.reason,
            duration_ms: durationMs,
            ...(error && { error_type: error.type })
          }
        }
      });

      return { success: true, message: '[DRY-RUN] Session end metric logged' };
    }

    const response = await this.client.sendMetric(metric);

    logger.info(`[MetricsSender] Session end metric sent`, metric);

    return response;
  }

  /**
   * Send aggregated session metric
   * Called by SSO metrics sync plugin for periodic sync
   *
   * @param metric - Aggregated session metric
   */
  async sendSessionMetric(metric: SessionMetric): Promise<MetricsSyncResponse> {
    // Dry-run mode: log without sending
    if (this.dryRun) {
      logger.info('[MetricsSender] [DRY-RUN] Would send aggregated metric:', {
        endpoint: 'POST /v1/metrics',
        metric: {
          name: metric.name,
          attributes: {
            agent: metric.attributes.agent,
            session_id: metric.attributes.session_id,
            branch: metric.attributes.branch,
            total_user_prompts: metric.attributes.total_user_prompts,
            total_input_tokens: metric.attributes.total_input_tokens,
            total_output_tokens: metric.attributes.total_output_tokens
          }
        }
      });

      return { success: true, message: '[DRY-RUN] Aggregated metric logged' };
    }

    const response = await this.client.sendMetric(metric);

    logger.debug('[MetricsSender] Aggregated usage metric sent', {
      agent: metric.attributes.agent,
      branch: metric.attributes.branch,
      prompts: metric.attributes.total_user_prompts,
      tokens: metric.attributes.total_input_tokens + metric.attributes.total_output_tokens,
      session: metric.attributes.session_id
    });

    return response;
  }

  /**
   * Extract repository name from working directory
   * Format: parent/current
   *
   * @example
   * /Users/john/projects/codemie-code → projects/codemie-code
   * C:\Users\john\projects\codemie-code → projects\codemie-code
   */
  private extractRepository(workingDirectory: string): string {
    const parts = workingDirectory.split(/[/\\]/);
    const filtered = parts.filter(p => p.length > 0);

    if (filtered.length >= 2) {
      return `${filtered[filtered.length - 2]}/${filtered[filtered.length - 1]}`;
    }

    return filtered[filtered.length - 1] || 'unknown';
  }
}
