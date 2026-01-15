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
  metadata?: Record<string, unknown>;
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
