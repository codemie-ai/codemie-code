/**
 * Metrics Sync Processor (SSO Provider)
 *
 * Lightweight processor that syncs metric deltas to CodeMie API.
 *
 * Responsibilities:
 * - Read pending metric deltas from JSONL (written by agent adapters)
 * - Aggregate deltas into metrics grouped by branch
 * - Send metrics to CodeMie API
 * - Mark deltas as 'synced' atomically
 *
 * Note: Delta extraction is handled by agent adapters (e.g., Claude's MetricsProcessor)
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../BaseProcessor.js';
import type { ParsedSession } from '../../BaseSessionAdapter.js';
import { logger } from '../../../../../../utils/logger.js';
import { MetricsSender } from './metrics-api-client.js';
import { aggregateDeltas } from './metrics-aggregator.js';
import { SessionStore } from '../../../../../../agents/core/session/SessionStore.js';
import { getSessionMetricsPath } from '../../../../../../agents/core/session/session-config.js';
import { readJSONL } from '../../utils/jsonl-reader.js';
import { writeJSONLAtomic } from '../../utils/jsonl-writer.js';
import type { MetricDelta } from '../../../../../../agents/core/metrics/types.js';

const MAX_SYNC_ATTEMPTS = 3;

export class MetricsSyncProcessor implements SessionProcessor {
  readonly name = 'metrics-sync';
  readonly priority = 2; // Run after metrics transformation (priority 1)

  private sessionStore = new SessionStore();
  private isSyncing = false; // Concurrency guard

  shouldProcess(_session: ParsedSession): boolean {
    // Always try to process - will check for pending deltas inside
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

      // 2. Retry pending deltas and previously failed deltas until the attempt cap.
      const pendingDeltas = allDeltas.filter(d =>
        d.syncStatus === 'pending' ||
        (d.syncStatus === 'failed' && d.syncAttempts < MAX_SYNC_ATTEMPTS)
      );

      if (pendingDeltas.length === 0) {
        logger.debug(`[${this.name}] No pending deltas to sync for session ${session.sessionId}`);
        return { success: true, message: 'No pending deltas' };
      }

      logger.info(`[${this.name}] Syncing usage data (${pendingDeltas.length} interaction${pendingDeltas.length !== 1 ? 's' : ''})`);

      if (logger.isDebugMode()) {
        logger.debug(`[${this.name}] Collected pending deltas:`, {
          count: pendingDeltas.length,
          deltas: pendingDeltas.map(d => {
            const totalTools = Object.values(d.tools || {}).reduce((sum: number, count: number) => sum + count, 0);
            let successCount = 0;
            let failureCount = 0;
            if (d.toolStatus) {
              for (const status of Object.values(d.toolStatus)) {
                successCount += status.success || 0;
                failureCount += status.failure || 0;
              }
            }

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
      }

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
      const clientType = context.clientType || 'codemie-cli';
      const metrics = aggregateDeltas(pendingDeltas, sessionMetadata, context.version, clientType, agentConfig);

      logger.info(`[${this.name}] Aggregated ${metrics.length} branch-specific metrics from ${pendingDeltas.length} deltas`);

      if (logger.isDebugMode()) {
        for (const metric of metrics) {
          if (!('total_user_prompts' in metric.attributes)) continue;

          logger.debug(`[${this.name}] Aggregated metric for branch "${metric.attributes.branch}":`, {
            name: metric.name,
            attributes: {
              agent: metric.attributes.agent,
              agent_version: metric.attributes.agent_version,
              codemie_client: metric.attributes.codemie_client,
              llm_model: metric.attributes.llm_model,
              repository: metric.attributes.repository,
              session_id: metric.attributes.session_id,
              branch: metric.attributes.branch,
              total_user_prompts: metric.attributes.total_user_prompts,
              tool_names: metric.attributes.tool_names,
              total_tool_calls: metric.attributes.total_tool_calls,
              successful_tool_calls: metric.attributes.successful_tool_calls,
              failed_tool_calls: metric.attributes.failed_tool_calls,
              files_created: metric.attributes.files_created,
              files_modified: metric.attributes.files_modified,
              files_deleted: metric.attributes.files_deleted,
              total_lines_added: metric.attributes.total_lines_added,
              total_lines_removed: metric.attributes.total_lines_removed,
              session_duration_ms: metric.attributes.session_duration_ms,
              count: metric.attributes.count
            }
          });
        }
      }

      // 6. Initialize metrics sender
      const metricsSender = new MetricsSender({
        baseUrl: context.apiBaseUrl,
        cookies: context.cookies,
        apiKey: context.apiKey,
        timeout: 30000,
        retryAttempts: 3,
        version: context.version,
        clientType,
        dryRun: context.dryRun
      });

      // 7. Send each branch metric to API (dry-run handled by MetricsSender)
      const successfulRecordIds = new Set<string>();
      const failedByRecordId = new Map<string, string>();

      for (const metric of metrics) {
        const branchDeltas = pendingDeltas.filter((delta) =>
          (delta.gitBranch || 'unknown') === metric.attributes.branch
        );

        try {
          const response = await metricsSender.sendSessionMetric(metric);

          if (!response.success) {
            logger.error(`[${this.name}] Sync failed for branch "${metric.attributes.branch}": ${response.message}`);
            for (const delta of branchDeltas) {
              failedByRecordId.set(delta.recordId, response.message);
            }
            continue;
          }

          for (const delta of branchDeltas) {
            successfulRecordIds.add(delta.recordId);
          }
          logger.info(`[${this.name}] Successfully synced metric for branch "${metric.attributes.branch}"`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`[${this.name}] Sync threw for branch "${metric.attributes.branch}": ${message}`);
          for (const delta of branchDeltas) {
            failedByRecordId.set(delta.recordId, message);
          }
        }
      }

      // 8. Mark deltas as synced/failed in JSONL (atomic rewrite)
      const syncedAt = Date.now();

      const updatedDeltas = allDeltas.map((d): MetricDelta => {
        if (successfulRecordIds.has(d.recordId)) {
          return {
            ...d,
            syncStatus: 'synced',
            syncAttempts: d.syncAttempts + 1,
            syncedAt,
            syncError: undefined,
          };
        }

        const syncError = failedByRecordId.get(d.recordId);
        if (syncError) {
          return {
            ...d,
            syncStatus: 'failed',
            syncAttempts: d.syncAttempts + 1,
            syncError,
          };
        }

        return d;
      });

      await writeJSONLAtomic(metricsFile, updatedDeltas);

      const successCount = successfulRecordIds.size;
      const failedCount = failedByRecordId.size;
      const message = `Synced ${successCount}/${pendingDeltas.length} deltas across ${metrics.length} branches`;
      if (failedCount > 0) {
        logger.warn(`[${this.name}] ${message}; ${failedCount} failed`);
      } else {
        logger.info(`[${this.name}] Successfully ${message}`);
      }

      // Debug: Log which deltas were marked as synced
      logger.debug(`[${this.name}] Marked deltas as synced:`, {
        syncedAt: new Date(syncedAt).toISOString(),
        recordIds: Array.from(successfulRecordIds),
        failedRecordIds: Array.from(failedByRecordId.keys()),
        totalDeltasInFile: updatedDeltas.length,
        syncedCount: updatedDeltas.filter(d => d.syncStatus === 'synced').length,
        failedCount: updatedDeltas.filter(d => d.syncStatus === 'failed').length,
        pendingCount: updatedDeltas.filter(d => d.syncStatus === 'pending').length
      });

      return {
        success: failedCount === 0,
        message,
        metadata: {
          deltasProcessed: successCount,
          deltasFailed: failedCount,
          branchCount: metrics.length,
          syncUpdates: {
            metrics: {
              processedRecordIds: Array.from(successfulRecordIds),
              totalSynced: successCount,
              totalFailed: failedCount,
              totalDeltas: pendingDeltas.length
            }
          }
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
