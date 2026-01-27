/**
 * Conversation Payload Types
 *
 * Type definitions for conversation payloads and API client.
 */

/**
 * Conversation payload record stored in JSONL
 * Used for tracking conversation sync status
 */
export interface ConversationPayloadRecord {
  /** Timestamp when sync was attempted */
  timestamp: number;

  /** Whether this was a turn continuation */
  isTurnContinuation: boolean;

  /** History indices being synced */
  historyIndices: number[];

  /** Number of messages in payload */
  messageCount: number;

  /** Last processed message UUID from transformation (for sync state tracking) */
  lastProcessedMessageUuid?: string;

  /** The exact payload sent to API */
  payload: {
    conversationId: string;
    history: any[];
  };

  /** Sync result status */
  status: 'pending' | 'success' | 'failed';

  /** Error message if failed */
  error?: string;

  /** Response metadata (if available) */
  response?: {
    statusCode?: number;
    syncedCount?: number;
  };
}

/**
 * Configuration for ConversationApiClient
 */
export interface ConversationApiConfig {
  baseUrl: string;
  cookies?: string;
  apiKey?: string;
  timeout?: number;
  retryAttempts?: number;
  version?: string;
  clientType?: string;
  dryRun?: boolean;
}

/**
 * Response from conversation sync API
 */
export interface ConversationSyncResponse {
  success: boolean;
  message: string;
  conversation_id?: string;
  new_messages?: number;
  total_messages?: number;
  created?: boolean;
}

/**
 * CodeMie history entry format for API
 */
export interface CodemieHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
  [key: string]: any;
}
