/**
 * Base Session Adapter
 *
 * Defines the contract for agent-specific session parsing.
 * Each agent (Claude, Codex, Gemini) implements this interface to parse
 * their session file format into a unified ParsedSession format.
 */

/**
 * Agent-agnostic session representation.
 * Both metrics and conversations processors work with this unified format.
 */
export interface ParsedSession {
  // Identity
  sessionId: string;
  agentName: string;  // Display name (e.g., 'Claude Code'), not internal ID
  agentVersion?: string;

  // Session metadata
  metadata: {
    projectPath?: string;
    createdAt?: string;
    updatedAt?: string;
    repository?: string;
    branch?: string;
  };

  // Raw messages (agent-specific format preserved for conversations processor)
  messages: unknown[];

  // Sub-agent sessions (for Task tool invocations)
  // CRITICAL: These must be discovered and parsed during parseSessionFile()
  subagents?: Array<{
    agentId: string;
    slug?: string;
    filePath: string;
    messages: unknown[]; // Pre-parsed messages from sub-agent file
  }>;

  // Parsed metrics data (optional - for metrics processor)
  metrics?: {
    tokens?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
    tools?: Record<string, number>;
    toolStatus?: Record<string, { success: number; failure: number }>;
    fileOperations?: Array<{
      type: 'write' | 'edit' | 'delete';
      path: string;
      linesAdded?: number;
      linesRemoved?: number;
    }>;
  };
}

/**
 * Aggregated result from processing a session with multiple processors.
 * Contains results from all processors that ran.
 */
export interface AggregatedResult {
  /** True if all processors succeeded */
  success: boolean;
  /** Results from each processor by name */
  processors: Record<string, {
    success: boolean;
    message?: string;
    recordsProcessed?: number;
  }>;
  /** Total records processed across all processors */
  totalRecords: number;
  /** Names of failed processors */
  failedProcessors: string[];
}

/**
 * Base interface for session adapters.
 * Each agent implements this to provide agent-specific parsing logic.
 */
export interface SessionAdapter {
  /** Agent name (e.g., 'claude', 'codex', 'gemini') */
  readonly agentName: string;

  /**
   * Parse session file to unified format.
   * @param filePath - Absolute path to session file
   * @param sessionId - CodeMie session ID (already correlated)
   * @returns Parsed session in agent-agnostic format
   */
  parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession>;

  /**
   * Register a processor to run during session processing.
   * Processors are sorted by priority (lower runs first).
   * @param processor - Processor to register
   */
  registerProcessor(processor: import('./BaseProcessor.js').SessionProcessor): void;

  /**
   * Process session file with all registered processors.
   * Reads file once, passes ParsedSession to all processors.
   *
   * @param filePath - Path to agent session file
   * @param sessionId - CodeMie session ID
   * @param context - Processing context (for processors that need API access)
   * @returns Aggregated results from all processors
   */
  processSession(
    filePath: string,
    sessionId: string,
    context: import('./BaseProcessor.js').ProcessingContext
  ): Promise<AggregatedResult>;
}
