/**
 * Metrics Processor
 *
 * Processes parsed session data to sync metrics to CodeMie API.
 * Extracts complete logic from sso.metrics-sync.plugin.ts
 *
 * Responsibilities:
 * - Read pending metric deltas from JSONL file
 * - Load session metadata
 * - Aggregate deltas into metrics grouped by branch
 * - Send metrics to API
 * - Mark deltas as synced
 *
 * IMPORTANT: This processor reads from the separate metrics delta file,
 * not from the session messages. The session provides metadata only.
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../base/BaseProcessor.js';
import type { ParsedSession } from '../../adapters/base/BaseSessionAdapter.js';
import { logger } from '../../../../../../utils/logger.js';
import { MetricsSender } from './metrics-api-client.js';
import { aggregateDeltas } from './metrics-aggregator.js';
import { SessionStore } from '../../../../../../agents/core/session/SessionStore.js';
import { getSessionMetricsPath } from '../../../../../../agents/core/metrics-config.js';
import { readJSONL } from '../../utils/jsonl-reader.js';
import { writeJSONLAtomic } from '../../utils/jsonl-writer.js';
import type { MetricDelta } from '../../../../../../agents/core/metrics/types.js';

export class MetricsProcessor implements SessionProcessor {
  readonly name = 'metrics';
  readonly priority = 1; // Run first

  private sessionStore = new SessionStore();
  private isSyncing = false;

  shouldProcess(_session: ParsedSession): boolean {
    // Process all sessions - metrics deltas are tracked separately
    return true;
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    // Skip if already syncing (prevent concurrent syncs)
    if (this.isSyncing) {
      logger.debug(`[${this.name}] Sync already in progress, skipping`);
      return { success: true, message: 'Sync in progress' };
    }

    this.isSyncing = true;

    try {
      const metricsFile = getSessionMetricsPath(session.sessionId);

      // 1. Read all deltas from JSONL
      const allDeltas = await readJSONL<MetricDelta>(metricsFile);

      // 2. Filter for pending deltas only
      const pendingDeltas = allDeltas.filter(d => d.syncStatus === 'pending');

      if (pendingDeltas.length === 0) {
        logger.debug(`[${this.name}] No pending deltas to sync for session ${session.sessionId}`);
        return { success: true, message: 'No pending deltas' };
      }

      logger.info(`[${this.name}] Syncing usage data (${pendingDeltas.length} interaction${pendingDeltas.length !== 1 ? 's' : ''})`);

      // Debug: Log collected deltas
      logger.debug(`[${this.name}] Collected pending deltas:`, {
        count: pendingDeltas.length,
        deltas: pendingDeltas.map(d => {
          // Calculate tool stats from tools and toolStatus
          const totalTools = Object.values(d.tools || {}).reduce((sum: number, count: number) => sum + count, 0);
          let successCount = 0;
          let failureCount = 0;
          if (d.toolStatus) {
            for (const status of Object.values(d.toolStatus)) {
              successCount += (status as { success: number; failure: number }).success || 0;
              failureCount += (status as { success: number; failure: number }).failure || 0;
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
      const sessionMetadata = await this.sessionStore.loadSession(session.sessionId);

      if (!sessionMetadata) {
        logger.error(`[${this.name}] Session not found: ${session.sessionId}`);
        return { success: false, message: 'Session metadata not found' };
      }

      // 4. Get agent metrics config for post-processing (lazy-load to avoid circular dependency)
      let agentConfig;
      try {
        const {AgentRegistry} = await import('../../../../../../agents/registry.js');
        const agent = AgentRegistry.getAgent(sessionMetadata.agentName);
        agentConfig = agent?.getMetricsConfig();
      } catch (error) {
        logger.debug(`[${this.name}] Could not load AgentRegistry: ${error}`);
        agentConfig = undefined;
      }

      // 5. Aggregate pending deltas into metrics grouped by branch
      const metrics = aggregateDeltas(pendingDeltas, sessionMetadata, context.version, agentConfig);

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

      // 6. Initialize metrics sender
      const metricsSender = new MetricsSender({
        baseUrl: context.apiBaseUrl,
        cookies: context.cookies,
        apiKey: context.apiKey,
        timeout: 30000,
        retryAttempts: 3,
        version: context.version,
        clientType: context.clientType || 'codemie-cli',
        dryRun: context.dryRun
      });

      // 7. Send each branch metric to API (dry-run handled by MetricsSender)
      for (const metric of metrics) {
        const response = await metricsSender.sendSessionMetric(metric);

        if (!response.success) {
          logger.error(`[${this.name}] Sync failed for branch "${metric.attributes.branch}": ${response.message}`);
          // Continue with other branches even if one fails
          continue;
        }

        logger.info(`[${this.name}] Successfully synced metric for branch "${metric.attributes.branch}"`);
      }

      // 8. Mark deltas as synced in JSONL (atomic rewrite)
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

      return {
        success: true,
        message: `Synced ${pendingDeltas.length} deltas across ${metrics.length} branches`,
        metadata: {
          deltasProcessed: pendingDeltas.length,
          branchCount: metrics.length
        }
      };

    } catch (error) {
      logger.error(`[${this.name}] Sync failed:`, error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      };

    } finally {
      this.isSyncing = false;
    }
  }
}
