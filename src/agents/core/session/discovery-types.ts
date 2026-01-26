/**
 * Session Discovery Types
 *
 * Types for discovering agent sessions with filtering.
 * Used by SessionAdapter.discoverSessions() optional method.
 */

/**
 * Options for session discovery
 */
export interface SessionDiscoveryOptions {
  /**
   * Filter sessions for specific project directory.
   * Matches against session's working directory / project path.
   * Trailing slashes are normalized for comparison.
   */
  cwd?: string;

  /**
   * Maximum age in days for sessions to include.
   * Sessions older than this are excluded.
   * @default 30
   */
  maxAgeDays?: number;

  /**
   * Maximum number of sessions to return.
   * Applied after sorting (returns newest sessions).
   */
  limit?: number;

  /**
   * Include sessions without timestamps.
   * If false (default), sessions without createdAt are excluded.
   * @default false
   */
  includeTimestampless?: boolean;
}

/**
 * Descriptor for a discovered session.
 * Contains enough information to load and process the session.
 */
export interface SessionDescriptor {
  /** Session ID (from filename or session content) */
  sessionId: string;

  /** Absolute path to session file */
  filePath: string;

  /** Project/working directory for the session (if available) */
  projectPath?: string;

  /** Session creation timestamp (milliseconds since epoch) */
  createdAt: number;

  /** Session update timestamp (milliseconds since epoch) */
  updatedAt?: number;

  /** Agent name that created this session */
  agentName?: string;
}
