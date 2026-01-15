/**
 * Session Infrastructure Types
 *
 * Core type definitions for session management system.
 * These types are shared across metrics, conversations, and other processors.
 */

/**
 * Correlation status
 */
export type CorrelationStatus = 'pending' | 'matched' | 'failed';

/**
 * Correlation result
 */
export interface CorrelationResult {
  status: CorrelationStatus;
  agentSessionFile?: string; // Path to matched file
  agentSessionId?: string; // Extracted session ID
  detectedAt?: number; // Unix timestamp (ms)
  retryCount: number;
}

/**
 * Session status
 */
export type SessionStatus = 'active' | 'completed' | 'recovered' | 'failed';

/**
 * Sync status (used by all processors)
 */
export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed';

/**
 * Conversations sync state (ConversationsProcessor)
 */
export interface ConversationsSyncState {
  // Conversation identity
  conversationId?: string;

  // Incremental tracking
  lastSyncedMessageUuid?: string;
  lastSyncedHistoryIndex?: number;

  // Remote sync state
  lastSyncAt?: number;

  // Statistics
  totalMessagesSynced?: number;
  totalSyncAttempts?: number;

  // Error tracking
  lastSyncError?: string;
}

/**
 * Metrics sync state (MetricsProcessor)
 * Re-exported from metrics/types.ts for convenience
 */
export interface MetricsSyncState {
  // Processing state (incremental tracking)
  lastProcessedLine?: number;
  lastProcessedTimestamp: number;
  processedRecordIds: string[];
  attachedUserPromptTexts?: string[];

  // Remote sync state
  lastSyncedRecordId?: string;
  lastSyncAt?: number;

  // Statistics
  totalDeltas: number;
  totalSynced: number;
  totalFailed: number;

  // Error tracking
  lastSyncError?: string;
}

/**
 * Hierarchical sync state (per-processor sections)
 */
export interface SyncState {
  metrics?: MetricsSyncState;
  conversations?: ConversationsSyncState;
}

/**
 * Session metadata (stored in ~/.codemie/sessions/{sessionId}.json)
 * Contains session info and sync state for all processors.
 *
 * This is the central session object used by:
 * - Hook handlers (SessionStart, Stop): Create and manage session lifecycle
 * - MetricsProcessor: Syncs metrics deltas
 * - ConversationsProcessor: Syncs conversation messages
 */
export interface Session {
  sessionId: string; // CodeMie session ID (UUID)
  agentName: string; // 'claude', 'gemini', 'codex'
  provider: string; // 'ai-run-sso', etc.
  project?: string; // SSO project name (optional, only for ai-run-sso provider)
  startTime: number; // Unix timestamp (ms)
  endTime?: number; // Unix timestamp (ms)
  workingDirectory: string; // CWD where agent was launched
  gitBranch?: string; // Git branch at session start (optional, detected from workingDirectory)

  correlation: CorrelationResult;
  status: SessionStatus;
  reason?: string; // Session end reason (optional, e.g., 'clear', 'logout', 'prompt_input_exit', 'other')

  // Hierarchical sync state
  sync?: SyncState;
}
