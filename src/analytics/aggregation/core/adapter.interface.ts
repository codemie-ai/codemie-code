/**
 * Agent Analytics Adapter Interface
 *
 * Defines the contract that all agent-specific analytics adapters must implement.
 * This interface enables standardized extraction of analytics data from different
 * agent log formats (JSON, JSONL, etc.).
 */

import {
  SessionQueryOptions,
  SessionDescriptor,
  CodemieSession,
  CodemieMessage,
  CodemieToolCall,
  CodemieFileModification
} from '../types.js';

/**
 * Base interface for agent analytics adapters
 */
export interface AgentAnalyticsAdapter {
  // === Metadata ===
  agentName: string;      // From plugin metadata (e.g., 'gemini')
  displayName: string;    // From plugin metadata (e.g., 'Gemini CLI')
  version: string;        // Adapter version

  // === Discovery ===
  /**
   * Find all sessions matching the query criteria
   * @param options Query options for filtering sessions
   * @returns Array of session descriptors (lightweight metadata)
   */
  findSessions(options?: SessionQueryOptions): Promise<SessionDescriptor[]>;

  // === Extraction ===
  /**
   * Extract full session details from a session descriptor
   * @param descriptor Session descriptor from findSessions()
   * @returns Complete session with aggregated statistics
   */
  extractSession(descriptor: SessionDescriptor): Promise<CodemieSession>;

  /**
   * Extract all messages from a session
   * @param descriptor Session descriptor
   * @returns Array of messages
   */
  extractMessages(descriptor: SessionDescriptor): Promise<CodemieMessage[]>;

  /**
   * Extract all tool calls from a session
   * @param descriptor Session descriptor
   * @returns Array of tool calls
   */
  extractToolCalls(descriptor: SessionDescriptor): Promise<CodemieToolCall[]>;

  /**
   * Extract all file modifications from a session
   * @param descriptor Session descriptor
   * @returns Array of file modifications
   */
  extractFileModifications(descriptor: SessionDescriptor): Promise<CodemieFileModification[]>;

  // === Validation ===
  /**
   * Validate that the adapter's data source is accessible
   * @returns true if data source exists and is readable
   */
  validateSource(): Promise<boolean>;
}

/**
 * Metadata passed from plugin to adapter constructor
 */
export interface AdapterMetadata {
  name: string;
  displayName: string;
  dataPaths?: {
    home: string;
    sessions?: string;
    settings?: string;
    cache?: string;
  };
}
