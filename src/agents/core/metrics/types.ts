/**
 * Metrics Collection Types
 *
 * Metrics-specific type definitions for the metrics collection system.
 * For core session types, see ../session/types.js
 */

import type { SyncStatus } from '../session/types.js';

export type { SyncStatus, MetricsSyncState, Session } from '../session/types.js';

/**
 * Tool execution status
 */
export type ToolStatus = 'pending' | 'success' | 'error';

/**
 * File operation type
 */
export type FileOperationType = 'read' | 'write' | 'edit' | 'delete' | 'glob' | 'grep';

/**
 * File operation details
 */
export interface FileOperation {
  type: FileOperationType;
  path?: string;
  pattern?: string; // For glob/grep operations
  language?: string; // Detected language (e.g., 'typescript', 'python')
  format?: string; // File format (e.g., 'ts', 'py', 'md')
  linesAdded?: number;
  linesRemoved?: number;
  linesModified?: number;
  durationMs?: number; // Tool execution time (from tool_result)
}

/**
 * Delta record (JSONL line in session_metrics.jsonl)
 * Each line represents incremental metrics for one turn
 */
export interface MetricDelta {
  // Identity
  recordId: string;              // UUID from message.uuid (for backtracking to agent session)
  sessionId: string;             // CodeMie session ID
  agentSessionId: string;        // Agent-specific session ID
  timestamp: number | string;    // Unix ms or ISO string
  gitBranch?: string;            // Git branch at time of this turn (can change mid-session)

  // Incremental metrics for this turn
  tokens: {
    input: number;
    output: number;
    cacheCreation?: number;
    cacheRead?: number;
  };

  // Tools used in this turn (counts)
  tools: {
    [toolName: string]: number;  // e.g., {"Read": 1, "Edit": 1}
  };

  // Tool execution status (success/failure breakdown)
  toolStatus?: {
    [toolName: string]: {
      success: number;
      failure: number;
    };
  };

  // File operations in this turn
  fileOperations?: {
    type: 'read' | 'write' | 'edit' | 'delete' | 'glob' | 'grep';
    path?: string;
    pattern?: string;
    language?: string;
    format?: string;
    linesAdded?: number;
    linesRemoved?: number;
    linesModified?: number;
    durationMs?: number;         // Tool execution time (from tool_result)
  }[];

  // Model tracking (raw names, unnormalized)
  models?: string[];             // All models used in this turn

  // API error details (if any tool failed)
  apiErrorMessage?: string;

  // User interaction metrics
  userPrompts?: {
    count: number;        // Number of user prompts in this turn
    text?: string;        // Actual prompt text (optional)
  }[];

  // Sync tracking
  syncStatus: SyncStatus;
  syncedAt?: number;
  syncAttempts: number;
  syncError?: string;
}

/**
 * User prompt record (from history file)
 */
export interface UserPrompt {
  display: string;       // The actual prompt text
  timestamp: number;     // Unix timestamp (ms)
  project: string;       // Working directory
  sessionId: string;     // Agent session ID
  pastedContents?: Record<string, unknown>; // Optional pasted content
}
