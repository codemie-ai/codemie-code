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
import { shouldStopSync, SyncStoppedError } from '../../../../../../agents/core/session/BaseProcessor.js';
import type { ParsedSession } from '../../BaseSessionAdapter.js';
import { logger } from '../../../../../../utils/logger.js';
import { MetricsSender } from './metrics-api-client.js';
import { aggregateDeltas, branchKeyOf } from './metrics-aggregator.js';
import { SessionStore } from '../../../../../../agents/core/session/SessionStore.js';
import { getSessionMetricsPath } from '../../../../../../agents/core/session/session-config.js';
import { readJSONLTolerant } from '@/agents/core/session/utils/jsonl-reader.js';
import { rewriteSessionFile } from '../../utils/locked-jsonl.js';
import type { MetricDelta } from '../../../../../../agents/core/metrics/types.js';
import type { Session } from '../../../../../../agents/core/session/types.js';
import { awaitsDestination, legacyMetricsVerdict, persistLegacyMetricsWithheld } from '@/agents/core/session/legacy-metrics-gate.js';
import { noteAwaitingDestination, type RequestOutcome } from '@/providers/plugins/sso/session/bounded-request.js';
import { SessionFileLockTimeoutError } from '@/utils/errors.js';

/**
 * Whether a metric delta may still be sent: pending or failed, however many attempts it has
 * (`syncAttempts` is diagnostic only; a `rejected` delta is terminal).
 */
export function isDeltaSendCandidate(delta: Pick<MetricDelta, 'syncStatus' | 'syncAttempts'>): boolean {
  return delta.syncStatus === 'pending' || delta.syncStatus === 'failed';
}

/**
 * Per branch: the last model of the newest delta on that branch that names one, else of the newest such delta
 * on any branch, whatever its sync status. The model does not depend on the branch, so a branch with no history
 * of its own keeps the session's.
 */
function lastKnownModelByBranch(deltas: MetricDelta[], session: Session): (branch: string) => string | undefined {
  const modeledNewestFirst = [...deltas].reverse().filter(d => d.models?.length);
  const sessionModel = modeledNewestFirst[0]?.models?.at(-1);
  return branch => modeledNewestFirst.find(d => branchKeyOf(d, session) === branch)?.models?.at(-1) ?? sessionModel;
}

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
      const allDeltas = await readJSONLTolerant<MetricDelta>(metricsFile, `[${this.name}]`);

      // 2. Retry pending and previously failed deltas; a rejected one is never resent.
      const pendingDeltas = allDeltas.filter(isDeltaSendCandidate);

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
              gitBranch: d.gitBranch || '(empty)',
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

      // The legacy work-consent gate (EPMCDME-17054): withheld deltas stay as they are, never sent or retried here.
      // A final verdict is persisted on the record, so the delivered checks count the deltas as delivered.
      const verdict = await legacyMetricsVerdict(sessionMetadata);
      if (!verdict.publish) {
        logger.debug(`[${this.name}] Legacy metrics withheld: ${verdict.reason}`);
        if (!('transient' in verdict)) await persistLegacyMetricsWithheld(session.sessionId, verdict.reason);
        // Reconciliation does not count this attempt: the deltas wait for the backend's answer, not for a retry
        if (awaitsDestination(verdict)) noteAwaitingDestination(context.abortSignal);
        return { success: true, message: `legacy metrics withheld: ${verdict.reason}` };
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
      // A branch whose pending deltas name no model keeps the branch's, else the session's, last known one.
      const metrics = aggregateDeltas(pendingDeltas, sessionMetadata, context.version, clientType, {
        agentConfig,
        fallbackModelByBranch: lastKnownModelByBranch(allDeltas, sessionMetadata)
      });

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
        dryRun: context.dryRun,
        deadlineMs: context.syncDeadlineMs,
        abortSignal: context.abortSignal,
        credentialsSuperseded: context.credentialsSuperseded
      });

      // 7. Send each branch metric to API (dry-run handled by MetricsSender)
      const successfulRecordIds = new Set<string>();
      const failedByRecordId = new Map<string, string>();
      const rejectedRecordIds = new Set<string>();
      let deferred = false;
      let processedBranches = 0;

      for (const metric of metrics) {
        // Stop BEFORE sending the next branch metric when the caller's sync
        // deadline expired or an abort was signaled (leftover deltas stay
        // pending for the next run).
        if (shouldStopSync(context)) {
          deferred = true;
          break;
        }
        processedBranches++;

        const branchDeltas = pendingDeltas.filter((delta) =>
          (delta.gitBranch || sessionMetadata.gitBranch || '') === metric.attributes.branch
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
          if (error instanceof SyncStoppedError) {
            // Stopped by the caller's abort / deadline: this branch's deltas stay pending
            deferred = true;
            processedBranches--;
            break;
          }
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`[${this.name}] Sync threw for branch "${metric.attributes.branch}": ${message}`);
          const rejected = (error as { outcome?: RequestOutcome } | null)?.outcome === 'rejected';
          for (const delta of branchDeltas) {
            failedByRecordId.set(delta.recordId, message);
            if (rejected) rejectedRecordIds.add(delta.recordId);
          }
        }
      }

      // 8. Mark deltas as synced/failed in JSONL (atomic rewrite).
      // Runs even when the loop stopped early: per-branch outcomes collected so
      // far are persisted, unprocessed branches keep their deltas pending.
      const syncedAt = Date.now();

      // The file is re-read under its lock: a line a hook appended during the network wait stays as read.
      const applyStatuses = (current: MetricDelta[]): MetricDelta[] => current.map((d): MetricDelta => {
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
            syncStatus: rejectedRecordIds.has(d.recordId) ? 'rejected' : 'failed',
            syncAttempts: d.syncAttempts + 1,
            syncError,
          };
        }

        return d;
      });

      let updatedDeltas = allDeltas;
      const successCount = successfulRecordIds.size;
      const failedCount = failedByRecordId.size;
      try {
        const rewritten = await rewriteSessionFile<MetricDelta>('metrics', session.sessionId, (current) => {
          updatedDeltas = applyStatuses(current);
          return updatedDeltas;
        }, context);
        if (!rewritten) {
          logger.warn(`[${this.name}] Metrics file of session ${session.sessionId} is gone, sync outcome dropped`);
        }
      } catch (error) {
        if (!(error instanceof SessionFileLockTimeoutError)) throw error;
        logger.warn(
          `[${this.name}] Metrics lock of session ${session.sessionId} stayed held: the outcomes of ${successCount} accepted / ` +
          `${failedCount} failed deltas were not persisted; they stay pending and will be re-sent`
        );
        return {
          success: true,
          message: `Sync not persisted: ${successCount}/${pendingDeltas.length} deltas accepted, their outcome not written (metrics lock held)`,
          metadata: { persisted: false }
        };
      }
      // Deferral is not a failure: remaining branch metrics stay pending for the next run
      const message = deferred
        ? `Sync deferred: ${metrics.length - processedBranches} items remaining (deadline/abort)`
        : `Synced ${successCount}/${pendingDeltas.length} deltas across ${metrics.length} branches`;
      if (deferred) {
        logger.info(`[${this.name}] ${message} (${successCount} deltas synced before stop)`);
      } else if (failedCount > 0) {
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
        success: deferred ? true : failedCount === 0,
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
