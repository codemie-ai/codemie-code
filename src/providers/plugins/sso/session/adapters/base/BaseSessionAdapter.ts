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
  agentName: string;
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
 * Base interface for session adapters.
 * Each agent implements this to provide agent-specific parsing logic.
 */
export interface SessionAdapter {
  /** Agent name (e.g., 'claude', 'codex', 'gemini') */
  readonly agentName: string;

  /**
   * Get session storage paths for this agent.
   * @returns Base directory and optional project subdirectories
   */
  getSessionPaths(): { baseDir: string; projectDirs?: string[] };

  /**
   * Check if file matches this agent's session file pattern.
   * @param filePath - Absolute path to file
   * @returns True if file is a session file for this agent
   */
  matchesSessionPattern(filePath: string): boolean;

  /**
   * Parse session file to unified format.
   * @param filePath - Absolute path to session file
   * @param sessionId - CodeMie session ID (already correlated)
   * @returns Parsed session in agent-agnostic format
   */
  parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession>;
}
