/**
 * Base Session Processor
 *
 * Defines the contract for session processors.
 * Each processor (metrics, conversations, analytics) implements this interface
 * to transform parsed session data for their specific use case.
 */

import type { ParsedSession } from './BaseSessionAdapter.js';

/**
 * Processing context passed to all processors.
 * Contains API credentials and configuration needed for processing.
 */
export interface ProcessingContext {
  /** API base URL */
  apiBaseUrl: string;
  /** Authentication cookies */
  cookies: string;
  /** API key for localhost development (user-id header) */
  apiKey?: string;
  /** Client type identifier */
  clientType: string;
  /** Client version */
  version: string;
  /** Dry run mode (don't send to API) */
  dryRun: boolean;

  // Hook-specific fields (optional, provided during hook-time extraction)
  /** CodeMie session ID */
  sessionId?: string;
  /** Agent-specific session ID (e.g., Claude's sessionId from JSONL) */
  agentSessionId?: string;
  /** Path to agent session file */
  agentSessionFile?: string;
  /** Git branch recorded for the CodeMie session */
  gitBranch?: string;

  // Sync control fields (optional, set by callers that must bound sync duration)
  /** Epoch milliseconds after which sync loops must stop sending and defer remaining work */
  syncDeadlineMs?: number;
  /** Abort signal (e.g. SIGTERM during agent teardown) asking sync loops to stop early */
  abortSignal?: AbortSignal;
  /** True only inside a `codemie hook` process (the agent's own hook, killed within its short budget) */
  hookProcess?: boolean;
  /**
   * Epoch ms of the next record's start over the same transcript: transcript records at or after it
   * belong to that later session, not to this one. Unset when no later record exists (or inside a hook process).
   */
  recordsBeforeMs?: number;
}

/** Why a bounded sync or request stopped before its work was done. */
export type SyncStopReason = 'aborted' | 'deadline';

/** The caller's abort or deadline, as given to the API clients and sync loops. */
export interface SyncBounds {
  /** Epoch ms after which no new attempt, backoff or request may run */
  deadlineMs?: number;
  /** Aborts the current request and backoff at once */
  abortSignal?: AbortSignal;
}

/**
 * Thrown by an API client stopped by its caller's abort or deadline. Not a failure:
 * the item it was sending stays pending for the next run.
 */
export class SyncStoppedError extends Error {
  constructor(readonly reason: SyncStopReason) {
    super(`Sync stopped (${reason})`);
    this.name = 'SyncStoppedError';
  }
}

/** The reason to stop now (abort first, then a passed deadline), or undefined. */
export function getSyncStopReason(bounds: SyncBounds): SyncStopReason | undefined {
  if (bounds.abortSignal?.aborted) {
    return 'aborted';
  }
  return bounds.deadlineMs !== undefined && Date.now() >= bounds.deadlineMs ? 'deadline' : undefined;
}

/**
 * Check whether a sync loop should stop sending new items and defer the rest.
 * True when the caller's abort signal fired or the sync deadline has passed.
 * Deferred items stay pending and are picked up by the next sync run.
 */
export function shouldStopSync(context: ProcessingContext): boolean {
  return getSyncStopReason({ deadlineMs: context.syncDeadlineMs, abortSignal: context.abortSignal }) !== undefined;
}

/**
 * Result of processing a session.
 * Allows tracking per-processor status.
 */
export interface ProcessingResult {
  /** Whether processing succeeded */
  success: boolean;
  /** Optional status message */
  message?: string;
  /** Optional metadata for tracking */
  metadata?: {
    recordsProcessed?: number;
    /** Session state updates to be applied by the adapter */
    syncUpdates?: {
      metrics?: {
        processedRecordIds?: string[];
        lastProcessedTimestamp?: number;
        totalDeltas?: number;
        totalSynced?: number;
        totalFailed?: number;
      };
      conversations?: {
        lastSyncedMessageUuid?: string;
        lastSyncedHistoryIndex?: number;
        totalMessagesSynced?: number;
        totalSyncAttempts?: number;
        conversationId?: string;
        lastSyncAt?: number;
      };
    };
    [key: string]: unknown;
  };
}

/**
 * Base interface for session processors.
 * Each processor implements a specific use case (metrics, conversations, analytics, etc.).
 */
export interface SessionProcessor {
  /** Processor name (used for logging and tracking) */
  readonly name: string;

  /** Execution priority (lower runs first) */
  readonly priority: number;

  /**
   * Check if this processor should run for the given session.
   * Allows conditional processing based on session data.
   *
   * @param session - Parsed session data
   * @returns True if processor should run
   */
  shouldProcess(session: ParsedSession): boolean;

  /**
   * Process a session.
   * Implements the specific transformation/upload logic for this processor.
   *
   * @param session - Parsed session data
   * @param context - Processing context (API credentials, config)
   * @returns Processing result (success/failure status)
   */
  process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult>;
}
