/**
 * CodeMie Agent Types
 *
 * Core TypeScript definitions for the CodeMie native coding agent
 * using LangChain v1.0+ and LangGraph v1.0+
 */

import type { FilterConfig } from './filters.js';

/**
 * Configuration interface for the CodeMie agent
 */
export interface CodeMieConfig {
  /** Base URL for the LLM API endpoint */
  baseUrl: string;

  /** Authentication token/API key */
  authToken: string;

  /** Model name (e.g., 'gpt-4', 'claude-3-sonnet-20240229') */
  model: string;

  /** LLM provider type */
  provider: 'openai' | 'azure' | 'bedrock' | 'litellm';

  /** Original provider name for display (before normalization) */
  displayProvider?: string;

  /** Request timeout in seconds */
  timeout: number;

  /** Working directory for file operations */
  workingDirectory: string;

  /** Enable debug logging */
  debug: boolean;

  /** Directory filtering configuration */
  directoryFilters?: FilterConfig;
}

/**
 * Tool metadata extracted from tool results for enhanced UI display
 */
export interface ToolMetadata {
  /** File path for file operations */
  filePath?: string;

  /** File size in bytes */
  fileSize?: number;

  /** Content preview (first few lines or characters) */
  contentPreview?: string;

  /** Number of bytes written */
  bytesWritten?: number;

  /** Directory path */
  directoryPath?: string;

  /** Number of files found */
  fileCount?: number;

  /** Number of directories found */
  directoryCount?: number;

  /** Command that was executed */
  command?: string;

  /** Execution time in milliseconds */
  executionTime?: number;

  /** Output preview */
  outputPreview?: string;

  /** Success status */
  success?: boolean;

  /** Error message if applicable */
  errorMessage?: string;

  /** Token usage for the LLM reasoning that led to this tool call */
  tokenUsage?: TokenUsage;

  /** Data processing metrics */
  dataMetrics?: {
    /** Amount of data read/processed (in bytes) */
    bytesProcessed?: number;
    /** Number of lines processed */
    linesProcessed?: number;
    /** Processing efficiency (bytes per token) */
    bytesPerToken?: number;
  };
}

/**
 * Agent event types for streaming responses
 */
export interface AgentEvent {
  /** Event type */
  type: 'thinking_start' | 'thinking_end' | 'content_chunk' |
        'tool_call_start' | 'tool_call_result' | 'complete' | 'error';

  /** Content chunk for streaming text */
  content?: string;

  /** Tool name being called */
  toolName?: string;

  /** Tool arguments */
  toolArgs?: Record<string, any>;

  /** Tool execution result */
  result?: string;

  /** Enhanced tool metadata for better UI display */
  toolMetadata?: ToolMetadata;

  /** Error message if event type is 'error' */
  error?: string;
}

/**
 * Callback function for handling agent events
 */
export type EventCallback = (event: AgentEvent) => void;

/**
 * Tool configuration interface
 */
export interface ToolConfig {
  /** Allowed directories for filesystem operations */
  allowedDirectories: string[];

  /** Working directory for command execution */
  workingDirectory: string;

  /** Enable debug mode for tools */
  debug: boolean;
}

/**
 * Agent execution options
 */
export interface ExecutionOptions {
  /** Maximum recursion limit for agent loops */
  recursionLimit?: number;

  /** Streaming mode configuration */
  streamMode?: 'updates' | 'values' | 'debug';

  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Agent initialization result
 */
export interface InitializationResult {
  /** Whether initialization was successful */
  success: boolean;

  /** Number of tools loaded */
  toolCount: number;

  /** Initialization duration in milliseconds */
  duration: number;

  /** Error message if initialization failed */
  error?: string;
}

/**
 * Tool execution context
 */
export interface ToolContext {
  /** Current working directory */
  workingDirectory: string;

  /** User ID or session identifier */
  sessionId?: string;

  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Token usage details for a single LLM call
 */
export interface TokenUsage {
  /** Input tokens (prompt) */
  inputTokens: number;

  /** Output tokens (completion) */
  outputTokens: number;

  /** Cached tokens (if supported by provider) */
  cachedTokens?: number;

  /** Total tokens (input + output) */
  totalTokens: number;

  /** Estimated cost in USD (if supported) */
  estimatedCost?: number;
}

/**
 * Step execution details with token tracking
 */
export interface ExecutionStep {
  /** Step number in the execution sequence */
  stepNumber: number;

  /** Type of step */
  type: 'llm_call' | 'tool_execution';

  /** Timestamp when step started */
  startTime: number;

  /** Timestamp when step completed */
  endTime?: number;

  /** Duration in milliseconds */
  duration?: number;

  /** Token usage for this step (only for llm_call type) */
  tokenUsage?: TokenUsage;

  /** Tool name (only for tool_execution type) */
  toolName?: string;

  /** Tool result success status (only for tool_execution type) */
  toolSuccess?: boolean;

  /** Error message if step failed */
  error?: string;

  /** Context for LLM calls to distinguish between different types of reasoning */
  llmContext?: 'initial_input' | 'processing_tool_result' | 'final_response';
}

/**
 * Agent runtime statistics with detailed token tracking
 */
export interface AgentStats {
  /** Total tokens used in input across all steps */
  inputTokens: number;

  /** Total tokens generated in output across all steps */
  outputTokens: number;

  /** Total cached tokens across all steps */
  cachedTokens: number;

  /** Total tokens (input + output) */
  totalTokens: number;

  /** Estimated total cost in USD */
  estimatedTotalCost: number;

  /** Total execution time in milliseconds */
  executionTime: number;

  /** Number of tool calls made */
  toolCalls: number;

  /** Number of successful tool executions */
  successfulTools: number;

  /** Number of failed tool executions */
  failedTools: number;

  /** Number of LLM calls made */
  llmCalls: number;

  /** Detailed execution steps */
  executionSteps: ExecutionStep[];
}

/**
 * Provider-specific configuration
 */
export type ProviderConfig = {
  openai: {
    apiKey: string;
    baseURL?: string;
    organization?: string;
  };
  azure: {
    apiKey: string;
    endpoint: string;
    deploymentName: string;
    apiVersion?: string;
  };
  bedrock: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  litellm: {
    apiKey: string;
    baseURL: string;
    model: string;
  };
};

/**
 * Error types for the agent
 */
export class CodeMieAgentError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'CodeMieAgentError';
  }
}

export class ToolExecutionError extends CodeMieAgentError {
  constructor(
    toolName: string,
    message: string,
    details?: Record<string, any>
  ) {
    super(`Tool '${toolName}' failed: ${message}`, 'TOOL_EXECUTION_ERROR', {
      toolName,
      ...details
    });
    this.name = 'ToolExecutionError';
  }
}

export class ConfigurationError extends CodeMieAgentError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'CONFIGURATION_ERROR', details);
    this.name = 'ConfigurationError';
  }
}

/**
 * Re-export commonly used types from dependencies
 */
export type { StructuredTool } from '@langchain/core/tools';
export type { BaseMessage } from '@langchain/core/messages';