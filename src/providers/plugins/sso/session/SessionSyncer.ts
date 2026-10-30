/**
 * Session Syncer Service
 *
 * Syncs pending metrics and conversations from JSONL to API.
 * Used by both proxy timer and SessionEnd hook for consistent behavior.
 *
 * Prerequisites: Messages must already be transformed to JSONL by Claude processors
 *
 * Flow:
 * 1. Load session metadata
 * 2. Create empty ParsedSession (triggers Branch 2 in processors)
 * 3. Iterate through processors (same logic as plugin)
 * 4. Return aggregated results
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../agents/core/session/BaseProcessor.js';
import { getSyncStopReason, type SyncStopReason } from '../../../../agents/core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../agents/core/session/BaseSessionAdapter.js';
import { open, readFile, stat, unlink } from 'fs/promises';
import { isOwnerAlive, isProcessAlive, processStartedAt } from '../../../../utils/processes.js';
import { parsePidLockHolder, reclaimStaleLock } from '../../../../utils/pid-lock.js';
import { logger } from '../../../../utils/logger.js';
import { getCodemiePath } from '../../../../utils/paths.js';
import { SessionStore } from '../../../../agents/core/session/SessionStore.js';
import { MetricsSyncProcessor } from './processors/metrics/metrics-sync-processor.js';
import { createSyncProcessor as createConversationSyncProcessor } from './processors/conversations/syncProcessor.js';
import { applyProcessingSyncUpdates } from '../../../../agents/core/session/sync-state-utils.js';
import { isExternalOrigin } from '../../../../agents/core/session/session-origin-audit.js';

export interface SessionSyncResult {
  success: boolean;
  message: string;
  processorResults: Record<string, ProcessingResult>;
  failedProcessors: string[];
}

/** A lock naming no pid is considered stale past this age (holder died without releasing) */
const SYNC_LOCK_STALE_MS = 120_000;

type SyncLockState =
  | 'acquired'        // We created the lock file and must release it
  | 'held-by-other'   // A live process holds the lock — defer this sync
  | 'unavailable';    // Lock could not be created (fs error) — proceed without it

export class SessionSyncer {
  private sessionStore = new SessionStore();
  private processors: SessionProcessor[];

  constructor() {
    // Initialize processors (sorted by priority)
    this.processors = [
      new MetricsSyncProcessor(),
      createConversationSyncProcessor()
    ].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Apply processor sync updates to session metadata.
   * Merges updates from all processors into session state.
   */
  private async applySyncUpdates(
    sessionId: string,
    results: ProcessingResult[]
  ): Promise<void> {
    try {
      const session = await this.sessionStore.loadSession(sessionId);

      if (!session) {
        logger.warn(`[SessionSyncer] Session not found for sync updates: ${sessionId}`);
        return;
      }

      const hasChanges = applyProcessingSyncUpdates(session, results);

      if (!hasChanges) {
        logger.debug('[SessionSyncer] No processor sync updates to persist');
        return;
      }

      // Persist session ONCE after all updates applied
      await this.sessionStore.saveSession(session);

      logger.debug(`[SessionSyncer] Session persisted after all processors completed`);
    } catch (error) {
      logger.error(`[SessionSyncer] Failed to apply sync updates:`, error);
      throw error;
    }
  }

  /**
   * Try to acquire the cross-process sync lock for a session (exclusive create).
   * A stale lock (holder killed mid-sync) is removed and acquisition retried once.
   * `pidOnly` (a hook process): the holder is checked by its pid alone, never by spawning `ps`.
   */
  private async tryAcquireSyncLock(lockPath: string, pidOnly: boolean): Promise<SyncLockState> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(lockPath, 'wx');
        try {
          // The holder's identity: a lock whose holder is dead is reclaimed at once
          await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: processStartedAt() }));
        } finally {
          await handle.close();
        }
        return 'acquired';
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          // Best effort: if the sessions dir is missing/unwritable, proceed
          // without a lock rather than blocking the sync entirely.
          logger.debug(`[SessionSyncer] Sync lock unavailable (${code ?? String(error)}), proceeding without lock`);
          return 'unavailable';
        }

        if (attempt === 0) {
          const raw = await readFile(lockPath, 'utf-8').catch(() => null);
          if (await this.isSyncLockStale(lockPath, raw, pidOnly)) {
            logger.debug(`[SessionSyncer] Removing stale sync lock: ${lockPath}`);
            if (await reclaimStaleLock(lockPath, raw)) continue;
          }
        }

        return 'held-by-other';
      }
    }
    return 'held-by-other';
  }

  /**
   * A lock naming a holder pid is stale when that holder is dead ({@link isOwnerAlive});
   * a lock naming no pid is stale when its mtime is older than SYNC_LOCK_STALE_MS.
   * `raw` is the lock content, null when it could not be read. Read / stat errors (e.g. lock
   * vanished between open and stat) are treated as stale so acquisition is retried once.
   */
  private async isSyncLockStale(lockPath: string, raw: string | null, pidOnly: boolean): Promise<boolean> {
    if (raw === null) return true;
    try {
      const holder = parsePidLockHolder(raw);
      if (holder) {
        return !(pidOnly ? isProcessAlive(holder.pid) : await isOwnerAlive(holder));
      }
      const stats = await stat(lockPath);
      return Date.now() - stats.mtimeMs > SYNC_LOCK_STALE_MS;
    } catch {
      return true;
    }
  }

  private async releaseSyncLock(lockPath: string): Promise<void> {
    try {
      await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug(`[SessionSyncer] Failed to release sync lock: ${error}`);
      }
    }
  }

  /**
   * Sync pending data to API
   * Iterates through processors (same logic as plugin)
   *
   * @param sessionId - CodeMie session ID
   * @param context - Processing context with API credentials
   * @returns Sync results
   */
  async sync(sessionId: string, context: ProcessingContext): Promise<SessionSyncResult> {
    logger.debug(`[SessionSyncer] Starting sync for session ${sessionId}`);

    // Cross-process guard: the SessionEnd hook, the proxy sync timer, and agent
    // incremental syncs can run concurrently for the same session. Only one sync
    // per session may run at a time; others defer to the next run.
    const lockPath = getCodemiePath('sessions', `${sessionId}.sync.lock`);
    const lockState = await this.tryAcquireSyncLock(lockPath, context.hookProcess === true);
    if (lockState === 'held-by-other') {
      logger.info(`[SessionSyncer] Sync already in progress for session ${sessionId} in another process, deferring`);
      return {
        success: true,
        message: 'Sync in progress in another process, deferred',
        processorResults: {},
        failedProcessors: []
      };
    }

    try {
      // 1. Load session metadata
      const sessionMetadata = await this.sessionStore.loadSession(sessionId);

      if (!sessionMetadata) {
        return {
          success: false,
          message: 'Session not found',
          processorResults: {},
          failedProcessors: []
        };
      }

      // Central ingestion gate: a confirmed external-resume session must never sync anything
      // (metrics or conversations), regardless of which caller (hook, proxy timer, codex
      // incremental sync, DesktopTelemetryRuntime) invoked this. See EPMCDME-12992.
      if (isExternalOrigin(sessionMetadata)) {
        logger.debug(`[SessionSyncer] Skipping sync for external-resume session ${sessionId}`);
        return {
          success: true,
          message: 'Sync skipped: external-resume session',
          processorResults: {},
          failedProcessors: []
        };
      }

      if (!sessionMetadata.correlation || sessionMetadata.correlation.status !== 'matched') {
        return {
          success: false,
          message: `Session not correlated (status: ${sessionMetadata.correlation?.status || 'unknown'})`,
          processorResults: {},
          failedProcessors: []
        };
      }

      // 2. Create empty ParsedSession to force processors into "sync mode" (Branch 2)
      //    Empty messages array ensures processors read pending JSONL instead of transforming
      const emptySession: ParsedSession = {
        sessionId,
        agentName: sessionMetadata.agentName,
        metadata: {},
        messages: [],  // Empty = triggers Branch 2
        metrics: {
          tools: {},
          toolStatus: {},
          fileOperations: []
        }
      };

      logger.debug(`[SessionSyncer] Processing session ${sessionId} with ${this.processors.length} processor${this.processors.length !== 1 ? 's' : ''}`);

      // 3. Iterate through processors and collect results
      const processorResults: Record<string, ProcessingResult> = {};
      const failedProcessors: string[] = [];
      const allResults: ProcessingResult[] = [];
      let stopReason: SyncStopReason | undefined;
      let skippedProcessors = 0;

      for (const [index, processor] of this.processors.entries()) {
        // Stop between processors when the sync deadline expired or an abort was
        // signaled; processors that did not run are deferred to the next sync.
        stopReason = getSyncStopReason({ deadlineMs: context.syncDeadlineMs, abortSignal: context.abortSignal });
        if (stopReason) {
          skippedProcessors = this.processors.length - index;
          logger.debug('[SessionSyncer] Sync deadline reached or aborted, deferring remaining processors');
          break;
        }

        try {
          // Check if processor should run for this session
          if (!processor.shouldProcess(emptySession)) {
            logger.debug(`[SessionSyncer] Processor ${processor.name} skipped (shouldProcess=false)`);
            continue;
          }

          logger.debug(`[SessionSyncer] Running processor: ${processor.name} (priority ${processor.priority})`);

          // Process session
          const result = await processor.process(emptySession, context);
          processorResults[processor.name] = result;
          allResults.push(result);

          if (result.success) {
            logger.debug(`[SessionSyncer] Processor ${processor.name} succeeded: ${result.message || 'OK'}`);
          } else {
            logger.error(`[SessionSyncer] Processor ${processor.name} failed: ${result.message}`);
            failedProcessors.push(processor.name);
          }

        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[SessionSyncer] Processor ${processor.name} threw error:`, error);
          const failedResult: ProcessingResult = {
            success: false,
            message: errorMessage
          };
          processorResults[processor.name] = failedResult;
          allResults.push(failedResult);
          failedProcessors.push(processor.name);
        }
      }

      // 4. Apply all sync updates and persist session ONCE
      await this.applySyncUpdates(sessionId, allResults);

      // 5. Build result message
      // Extract detailed stats
      const parts: string[] = [];
      const metricsResult = processorResults['metrics-sync'];
      const conversationsResult = processorResults['conversation-sync'];

      if (metricsResult?.success && metricsResult.metadata?.deltasProcessed) {
        parts.push(`${metricsResult.metadata.deltasProcessed} metrics`);
      }
      if (conversationsResult?.success && conversationsResult.metadata?.payloadsSynced) {
        parts.push(`${conversationsResult.metadata.payloadsSynced} conversations`);
      }

      const totalCount = Object.keys(processorResults).length;
      const stopMessage = stopReason
        ? `sync stopped early (${stopReason}), ${skippedProcessors} processors skipped`
        : undefined;
      const message = failedProcessors.length > 0
        ? `Sync completed with ${failedProcessors.length}/${totalCount} failures`
        : stopMessage
          ? parts.length > 0 ? `Synced ${parts.join(', ')}; ${stopMessage}` : stopMessage
          : parts.length > 0 ? `Synced ${parts.join(', ')}` : 'No pending data to sync';

      logger.info(`[SessionSyncer] ${message}`);

      return {
        success: failedProcessors.length === 0,
        message,
        processorResults,
        failedProcessors
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[SessionSyncer] Sync failed: ${errorMessage}`);
      return {
        success: false,
        message: errorMessage,
        processorResults: {},
        failedProcessors: []
      };
    } finally {
      if (lockState === 'acquired') {
        await this.releaseSyncLock(lockPath);
      }
    }
  }
}
