/**
 * Claude Message Types
 *
 * Type definitions for Claude session JSONL format.
 * Used by ClaudeSessionAdapter to parse session files from ~/.claude/projects/
 */

/**
 * Claude session message (from ~/.claude/projects/*.jsonl)
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
    id?: string;  // API-level message ID (shared by streaming chunks)
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

/**
 * Content item in Claude message
 */
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

/**
 * Tool use block in Claude message
 */
export interface ToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
