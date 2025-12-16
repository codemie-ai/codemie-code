/**
 * Metrics Sync Plugin
 * Priority: 100 (runs after logging plugin)
 *
 * Purpose: Syncs metrics to CodeMie API in background
 * - Runs only in SSO mode (ai-run-sso provider)
 * - Background timer (every 5 minutes)
 * - Aggregates pending deltas into single metric
 * - Marks deltas as synced in JSONL
 * - Final sync on proxy shutdown
 *
 * SOLID: Single responsibility = sync metrics
 * KISS: Simple timer-based sync
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { logger } from '../../utils/logger.js';
import { MetricsApiClient } from '../../metrics/sync/MetricsApiClient.js';
import { readJSONL, writeJSONLAtomic } from '../../metrics/sync/jsonl-writer.js';
import { aggregateDeltas } from '../../metrics/sync/aggregator.js';
import { SessionStore } from '../../metrics/session/SessionStore.js';
import { getSessionMetricsPath } from '../../metrics/config.js';

export class MetricsSyncPlugin implements ProxyPlugin {
  id = '@codemie/proxy-metrics-sync';
  name = 'Metrics Sync';
  version = '1.0.0';
  priority = 100; // Run after logging (priority 50)

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    // Only create interceptor if we have necessary context
    if (!context.config.sessionId) {
      logger.debug('[MetricsSyncPlugin] Skipping: Session ID not available');
      throw new Error('Session ID not available (metrics sync disabled)');
    }

    if (!context.credentials) {
      logger.debug('[MetricsSyncPlugin] Skipping: SSO credentials not available');
      throw new Error('SSO credentials not available (metrics sync disabled)');
    }

    // Check if metrics sync is enabled (from config or env var)
    const syncEnabled = this.isSyncEnabled(context);
    if (!syncEnabled) {
      logger.debug('[MetricsSyncPlugin] Skipping: Metrics sync disabled by configuration');
      throw new Error('Metrics sync disabled by configuration');
    }

    logger.debug('[MetricsSyncPlugin] Initializing metrics sync');

    // Check if dry-run mode is enabled
    const dryRun = this.isDryRunEnabled(context);

    return new MetricsSyncInterceptor(
      context.config.sessionId,
      context.config.targetApiUrl,
      context.credentials.cookies,
      context.config.clientType,
      context.config.version,
      dryRun
    );
  }

  /**
   * Check if metrics sync is enabled
   * Priority: ENV > Profile config > Default (true)
   */
  private isSyncEnabled(context: PluginContext): boolean {
    // Check environment variable first
    const envEnabled = process.env.CODEMIE_METRICS_SYNC_ENABLED;
    if (envEnabled !== undefined) {
      return envEnabled === 'true' || envEnabled === '1';
    }

    // Check profile config (if available)
    if (context.profileConfig?.metrics?.sync?.enabled !== undefined) {
      return context.profileConfig.metrics.sync.enabled;
    }

    // Default to enabled for SSO mode
    return true;
  }

  /**
   * Check if dry-run mode is enabled
   * Priority: ENV > Profile config > Default (false)
   */
  private isDryRunEnabled(context: PluginContext): boolean {
    // Check environment variable first
    const envDryRun = process.env.CODEMIE_METRICS_DRY_RUN;
    if (envDryRun !== undefined) {
      return envDryRun === 'true' || envDryRun === '1';
    }

    // Check profile config (if available)
    if (context.profileConfig?.metrics?.sync?.dryRun !== undefined) {
      return context.profileConfig.metrics.sync.dryRun;
    }

    // Default to disabled
    return false;
  }
}

class MetricsSyncInterceptor implements ProxyInterceptor {
  name = 'metrics-sync';

  private syncTimer?: NodeJS.Timeout;
  private sessionStore = new SessionStore();
  private apiClient: MetricsApiClient;
  private syncInterval: number;
  private isSyncing = false;
  private version: string;
  private dryRun: boolean;

  constructor(
    private sessionId: string,
    baseUrl: string,
    cookies: Record<string, string>,
    clientType?: string,
    version?: string,
    dryRun: boolean = false
  ) {
    // Get version from proxy config (passed from AgentCLI)
    this.version = version || '0.0.0';

    // Set dry-run mode (passed from plugin)
    this.dryRun = dryRun;

    if (this.dryRun) {
      logger.info('[metrics-sync] Dry-run mode enabled - metrics will be logged but not sent');
    }

    // Build cookie header
    const cookieHeader = Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');

    this.apiClient = new MetricsApiClient({
      baseUrl,
      cookies: cookieHeader,
      timeout: 30000,
      retryAttempts: 3,
      version: this.version,
      clientType: clientType || 'codemie-cli'
    });

    // Get sync interval from env or default to 5 minutes
    this.syncInterval = Number.parseInt(
      process.env.CODEMIE_METRICS_SYNC_INTERVAL || '300000',
      10
    );
  }

  /**
   * Called when proxy starts - initialize background timer
   */
  async onProxyStart(): Promise<void> {
    logger.info(`[${this.name}] Starting metrics sync (interval: ${this.syncInterval}ms)`);

    // Start background timer
    this.syncTimer = setInterval(() => {
      this.syncMetrics().catch(error => {
        logger.error(`[${this.name}] Sync failed:`, error);
      });
    }, this.syncInterval);

    logger.debug(`[${this.name}] Background timer started`);
  }

  /**
   * Called when proxy stops - cleanup and final sync
   */
  async onProxyStop(): Promise<void> {
    logger.info(`[${this.name}] Stopping metrics sync`);

    // Stop timer
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }

    // Final sync (ensure all pending metrics are sent)
    try {
      await this.syncMetrics();
      logger.info(`[${this.name}] Final sync completed`);
    } catch (error) {
      logger.error(`[${this.name}] Final sync failed:`, error);
    }
  }

  /**
   * Sync metrics to API
   */
  private async syncMetrics(): Promise<void> {
    // Skip if already syncing (prevent concurrent syncs)
    if (this.isSyncing) {
      logger.debug(`[${this.name}] Sync already in progress, skipping`);
      return;
    }

    this.isSyncing = true;

    try {
      const metricsFile = getSessionMetricsPath(this.sessionId);

      // 1. Read all deltas from JSONL
      const allDeltas = await readJSONL(metricsFile);

      // 2. Filter for pending deltas only
      const pendingDeltas = allDeltas.filter(d => d.syncStatus === 'pending');

      if (pendingDeltas.length === 0) {
        logger.debug(`[${this.name}] No pending deltas to sync`);
        return;
      }

      logger.info(`[${this.name}] Syncing ${pendingDeltas.length} pending deltas`);

      // Debug: Log collected deltas
      logger.debug(`[${this.name}] Collected pending deltas:`, {
        count: pendingDeltas.length,
        deltas: pendingDeltas.map(d => {
          // Calculate tool stats from tools and toolStatus
          const totalTools = Object.values(d.tools || {}).reduce((sum, count) => sum + count, 0);
          let successCount = 0;
          let failureCount = 0;
          if (d.toolStatus) {
            for (const status of Object.values(d.toolStatus)) {
              successCount += status.success || 0;
              failureCount += status.failure || 0;
            }
          }

          // Calculate file operation totals
          const fileOps = d.fileOperations || [];
          const linesAdded = fileOps.reduce((sum, op) => sum + (op.linesAdded || 0), 0);
          const linesRemoved = fileOps.reduce((sum, op) => sum + (op.linesRemoved || 0), 0);
          const writeOps = fileOps.filter(op => op.type === 'write').length;
          const editOps = fileOps.filter(op => op.type === 'edit').length;
          const deleteOps = fileOps.filter(op => op.type === 'delete').length;

          return {
            recordId: d.recordId,
            timestamp: typeof d.timestamp === 'number'
              ? new Date(d.timestamp).toISOString()
              : d.timestamp,
            tokens: d.tokens,
            tools: {
              total: totalTools,
              success: successCount,
              failure: failureCount,
              breakdown: d.tools
            },
            fileOperations: {
              created: writeOps,
              modified: editOps,
              deleted: deleteOps,
              linesAdded,
              linesRemoved
            }
          };
        })
      });

      // 3. Load session metadata
      const session = await this.sessionStore.loadSession(this.sessionId);

      if (!session) {
        logger.error(`[${this.name}] Session not found: ${this.sessionId}`);
        return;
      }

      // 4. Get agent metrics config for post-processing (lazy-load to avoid circular dependency)
      let agentConfig;
      try {
        const {AgentRegistry} = await import('../../agents/registry.js');
        const agent = AgentRegistry.getAgent(session.agentName);
        agentConfig = agent?.getMetricsConfig();
      } catch (error) {
        logger.debug(`[${this.name}] Could not load AgentRegistry: ${error}`);
        agentConfig = undefined;
      }

      // 5. Aggregate pending deltas into metrics grouped by branch
      const metrics = aggregateDeltas(pendingDeltas, session, this.version, agentConfig);

      logger.info(`[${this.name}] Aggregated ${metrics.length} branch-specific metrics from ${pendingDeltas.length} deltas`);

      // Debug: Log aggregated metrics
      for (const metric of metrics) {
        logger.debug(`[${this.name}] Aggregated metric for branch "${metric.attributes.branch}":`, {
          name: metric.name,
          attributes: {
            // Identity
            agent: metric.attributes.agent,
            agent_version: metric.attributes.agent_version,
            llm_model: metric.attributes.llm_model,
            repository: metric.attributes.repository,
            session_id: metric.attributes.session_id,
            branch: metric.attributes.branch,

            // Interaction totals
            total_user_prompts: metric.attributes.total_user_prompts,

            // Token totals
            total_input_tokens: metric.attributes.total_input_tokens,
            total_output_tokens: metric.attributes.total_output_tokens,
            total_cache_read_input_tokens: metric.attributes.total_cache_read_input_tokens,
            total_cache_creation_tokens: metric.attributes.total_cache_creation_tokens,

            // Tool totals
            total_tool_calls: metric.attributes.total_tool_calls,
            successful_tool_calls: metric.attributes.successful_tool_calls,
            failed_tool_calls: metric.attributes.failed_tool_calls,

            // File operation totals
            files_created: metric.attributes.files_created,
            files_modified: metric.attributes.files_modified,
            files_deleted: metric.attributes.files_deleted,
            total_lines_added: metric.attributes.total_lines_added,
            total_lines_removed: metric.attributes.total_lines_removed,

            // Session info
            session_duration_ms: metric.attributes.session_duration_ms,
            count: metric.attributes.count
          }
        });
      }

      // 5. Send each branch metric to API or log in dry-run mode
      if (this.dryRun) {
        // Dry-run mode: Log what would be sent without actually sending
        for (const metric of metrics) {
          logger.info(`[${this.name}] [DRY-RUN] Would send metric for branch "${metric.attributes.branch}" to API:`, {
            endpoint: `${this.apiClient['config'].baseUrl}/v1/metrics`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': `CodeMie-CLI/${this.version}`,
              'X-CodeMie-Client': this.apiClient['config'].clientType,
              'Cookie': '[REDACTED]'
            },
            payload: {
              name: metric.name,
              attributes: metric.attributes
            }
          });
        }
        logger.info(`[${this.name}] [DRY-RUN] Skipping actual API calls - ${pendingDeltas.length} deltas across ${metrics.length} branches would be synced`);
      } else {
        // Normal mode: Send each branch metric to API
        for (const metric of metrics) {
          const response = await this.apiClient.sendMetric(metric);

          if (!response.success) {
            logger.error(`[${this.name}] Sync failed for branch "${metric.attributes.branch}": ${response.message}`);
            // Continue with other branches even if one fails
            continue;
          }

          logger.info(`[${this.name}] Successfully synced metric for branch "${metric.attributes.branch}"`);
        }
      }

      // 6. Mark deltas as synced in JSONL (atomic rewrite)
      const syncedAt = Date.now();
      const pendingRecordIds = new Set(pendingDeltas.map(d => d.recordId));

      const updatedDeltas = allDeltas.map(d =>
        pendingRecordIds.has(d.recordId)
          ? {
              ...d,
              syncStatus: 'synced' as const,
              syncAttempts: d.syncAttempts + 1,
              syncedAt
            }
          : d
      );

      await writeJSONLAtomic(metricsFile, updatedDeltas);

      logger.info(
        `[${this.name}] Successfully synced ${pendingDeltas.length} deltas across ${metrics.length} branches`
      );

      // Debug: Log which deltas were marked as synced
      logger.debug(`[${this.name}] Marked deltas as synced:`, {
        syncedAt: new Date(syncedAt).toISOString(),
        recordIds: Array.from(pendingRecordIds),
        totalDeltasInFile: updatedDeltas.length,
        syncedCount: updatedDeltas.filter(d => d.syncStatus === 'synced').length,
        pendingCount: updatedDeltas.filter(d => d.syncStatus === 'pending').length
      });

    } catch (error) {
      logger.error(`[${this.name}] Sync failed:`, error);
      throw error;

    } finally {
      this.isSyncing = false;
    }
  }

}
