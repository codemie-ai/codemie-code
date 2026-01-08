/**
 * Generic Conversation API Types
 *
 * These types are agent-agnostic and define the API contract
 * for conversation sync endpoints.
 */

/**
 * Codemie conversation history entry (target format for API)
 */
export interface CodemieHistoryEntry {
  role: 'User' | 'Assistant';
  message: string;
  history_index: number;
  date: string;
  message_raw?: string;  // Raw user input (user messages only)
  file_names?: string[];
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  assistant_id?: string;
  thoughts?: Thought[];
  response_time?: number;  // Processing time in seconds (assistant messages only)
}

/**
 * Thought interface - represents a tool call with its input and result
 * Source: codemie-sdk (src/models/conversation.ts)
 */
export interface Thought {
  id: string;
  parent_id?: string;
  metadata: Record<string, unknown>;
  in_progress: boolean;
  input_text?: string;
  message?: string;
  author_type: string;
  author_name: string;
  output_format: string;
  error?: boolean;
  children: string[];
}

/**
 * Conversation API client configuration
 */
export interface ConversationApiConfig {
  baseUrl: string;       // API base URL
  cookies?: string;      // SSO cookies (session token)
  apiKey?: string;       // API key for localhost development
  timeout?: number;      // Request timeout (ms)
  retryAttempts?: number; // Max retry attempts
  version?: string;      // CLI version
  clientType?: string;   // Client type (codemie-claude, etc.)
  dryRun?: boolean;      // Dry-run mode (log but don't send)
}

/**
 * API response for successful conversation sync
 */
export interface ConversationSyncResponse {
  success: boolean;      // Whether the conversation was synced successfully
  message: string;       // Result message
  conversation_id?: string;
  new_messages?: number;
  total_messages?: number;
  created?: boolean;
}
