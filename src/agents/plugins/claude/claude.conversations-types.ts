/**
 * Conversation Sync Types
 *
 * Type definitions for conversation sync API integration
 * Syncs Claude Code conversation history to Codemie API
 */

/**
 * Claude session message types (from ~/.claude/projects/)
 */
export interface ClaudeMessage {
  type: 'user' | 'assistant' | 'system' | string;
  subtype?: 'api_error' | string;  // For system messages
  uuid: string;
  parentUuid?: string;
  sessionId: string;
  timestamp: string;
  cwd?: string;
  message?: {
    role: 'user' | 'assistant';
    model?: string;
    content: string | ContentItem[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    Output?: {  // Error structure (e.g., UnknownOperationException)
      __type?: string;
    };
    error?: {  // Error details
      message?: string;
      status?: number;
    };
  };
  error?: {  // System error (for type: 'system', subtype: 'api_error')
    status?: number;
    error?: {
      Message?: string;
      message?: string;
    };
  };
  toolUseResult?: {
    type: string;
    file?: {
      filePath: string;
      content: string;
    };
  };
}

export interface ContentItem {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  thinking?: string;  // For thinking blocks
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  isError?: boolean;
}

export interface ToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Codemie conversation types (target format for API)
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
 *
 * This matches the API's expected schema for tool execution tracking:
 * - author_name: Tool name (e.g., "Read", "Edit", "Bash")
 * - input_text: Tool parameters as JSON string
 * - message: Tool execution result/output
 * - author_type: Always "Tool" for tool executions
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

export interface UpsertHistoryRequest {
  assistant_id: string;
  folder?: string;
  history: CodemieHistoryEntry[];
}

export interface UpsertHistoryResponse {
  conversation_id: string;
  new_messages: number;
  total_messages: number;
  created: boolean;
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

/**
 * API error response from FastAPI ExtendedHTTPException
 */
export interface ConversationApiError {
  code: number;          // HTTP status code
  message: string;       // Error message
  details?: string;      // Detailed error information
  help?: string;         // Help text for resolving the error
}
