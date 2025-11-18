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
        'tool_call_start' | 'tool_call_progress' | 'tool_call_result' | 'complete' | 'error' |
        'todo_update' | 'planning_start' | 'planning_complete' |
        'planning_progress' | 'planning_tool_call' | 'planning_discovery' | 'planning_phase_change';

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

  /** Tool progress information (when type is 'tool_call_progress') */
  toolProgress?: {
    /** Progress percentage (0-100) */
    percentage: number;
    /** Current operation description */
    operation: string;
    /** Additional details */
    details?: string;
    /** Estimated time remaining in ms */
    estimatedTimeRemaining?: number;
  };

  /** Error message if event type is 'error' */
  error?: string;

  /** Todo update information (when type is 'todo_update') */
  todoUpdate?: {
    todos: Todo[];
    changedIndex?: number;
    previousState?: Todo[];
    changeType?: 'create' | 'update' | 'delete' | 'reorder';
  };

  /** Planning phase information */
  planningInfo?: {
    phase: 'starting' | 'in_progress' | 'completed' | 'failed';
    totalSteps?: number;
    currentStep?: number;
    message?: string;
  };

  /** Planning progress streaming (for planning_progress event) */
  planningProgress?: {
    /** Current planning phase */
    phase: 'context_gathering' | 'task_analysis' | 'plan_generation' | 'plan_validation';
    /** Descriptive message for current activity */
    message: string;
    /** Progress within current phase (0-100) */
    phaseProgress?: number;
    /** Overall planning progress (0-100) */
    overallProgress?: number;
    /** Additional details for UI display */
    details?: string;
  };

  /** Planning tool call information (for planning_tool_call event) */
  planningToolCall?: {
    /** Tool being called during planning */
    toolName: string;
    /** Tool arguments */
    args?: Record<string, any>;
    /** Current step within planning phase */
    step: number;
    /** Total steps in current phase */
    totalSteps: number;
    /** Purpose of this tool call */
    purpose: string;
  };

  /** Planning discovery information (for planning_discovery event) */
  planningDiscovery?: {
    /** Type of discovery */
    type: 'project_structure' | 'file_analysis' | 'dependency_analysis' | 'feature_detection';
    /** Discovery summary */
    summary: string;
    /** Discovered data */
    data?: Record<string, any>;
    /** Impact on planning */
    impact?: string;
  };

  /** Planning phase change information (for planning_phase_change event) */
  planningPhaseChange?: {
    /** Previous phase */
    fromPhase: string;
    /** New phase */
    toPhase: string;
    /** Phase transition message */
    message: string;
    /** Summary of previous phase results */
    previousPhaseResults?: Record<string, any>;
  };
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
 * Todo item for structured planning and progress tracking
 */
export interface Todo {
  /** The content/description of the todo item */
  content: string;

  /** Current status of the todo */
  status: 'pending' | 'in_progress' | 'completed';

  /** Optional index for ordering and reference */
  index?: number;

  /** Timestamp when todo was created */
  timestamp?: Date;

  /** Timestamp when todo was last updated */
  lastUpdated?: Date;

  /** Optional additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Agent state for persistent storage across interactions
 * Inspired by LangChain-Code's Deep Agent state management
 */
export interface CodeMieAgentState {
  /** Structured todos for planning and progress tracking */
  todos: Todo[];

  /** Virtual files for staging edits before writing to disk */
  files: Record<string, string>;

  /** Current step being executed (0-based index) */
  currentStep?: number;

  /** Whether initial planning phase is complete */
  planningComplete?: boolean;

  /** Planning mode configuration */
  planMode?: {
    enabled: boolean;
    requirePlanning: boolean;
    maxTodos: number;
    enforceSequential: boolean;
  };

  /** Session metadata */
  sessionMetadata?: {
    sessionId: string;
    startTime: Date;
    lastActivity: Date;
  };
}

/**
 * Todo update event for streaming interfaces
 */
export interface TodoUpdateEvent {
  /** Event type */
  type: 'todo_update';

  /** Current todo list */
  todos: Todo[];

  /** Index of changed todo (if specific update) */
  changedIndex?: number;

  /** Previous state for diff calculations */
  previousState?: Todo[];

  /** Type of change that occurred */
  changeType?: 'create' | 'update' | 'delete' | 'reorder';

  /** Timestamp of the update */
  timestamp: Date;
}

/**
 * Todo parsing result with validation information
 */
export interface TodoParseResult {
  /** Successfully parsed todos */
  todos: Todo[];

  /** Parse errors encountered */
  errors: string[];

  /** Warnings about format or content */
  warnings: string[];

  /** Input format detected */
  detectedFormat: 'string_bullets' | 'github_checkboxes' | 'object_array' | 'string_array' | 'mixed';
}

/**
 * Progress tracking information
 */
export interface ProgressInfo {
  /** Total number of todos */
  total: number;

  /** Number of completed todos */
  completed: number;

  /** Number of pending todos */
  pending: number;

  /** Number of in-progress todos (should be 0 or 1) */
  inProgress: number;

  /** Progress percentage (0-100) */
  percentage: number;

  /** Current active todo (if any) */
  currentTodo?: Todo;

  /** Estimated completion based on current pace */
  estimatedCompletion?: Date;
}

/**
 * Re-export commonly used types from dependencies
 */
export type { StructuredTool } from '@langchain/core/tools';
export type { BaseMessage } from '@langchain/core/messages';