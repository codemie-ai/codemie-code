/**
 * Base Analytics Adapter
 *
 * Provides common functionality for all agent analytics adapters.
 * Implements the AgentAnalyticsAdapter interface with shared logic.
 * Subclasses provide agent-specific session discovery and extraction.
 */

import { existsSync } from 'node:fs';
import {
  AgentAnalyticsAdapter,
  AdapterMetadata
} from './adapter.interface.js';
import { resolvePath } from './discovery.js';
import {
  SessionQueryOptions,
  SessionDescriptor,
  CodemieSession,
  CodemieMessage,
  CodemieToolCall,
  CodemieFileModification
} from '../types.js';

/**
 * Base Analytics Adapter
 *
 * Provides common functionality for all agent analytics adapters.
 * Implements the AgentAnalyticsAdapter interface with shared logic.
 * Subclasses provide agent-specific session discovery and extraction.
 */
export abstract class BaseAnalyticsAdapter implements AgentAnalyticsAdapter {
  // === Interface Properties ===
  agentName: string;
  displayName: string;
  version = '1.0.0';

  // === Protected Properties ===
  protected homePath: string;
  protected sessionsPath: string;

  /**
   * Constructor - Extracts metadata for all adapters
   */
  constructor(metadata: AdapterMetadata) {
    this.agentName = metadata.name;
    this.displayName = metadata.displayName;

    // Extract paths from metadata
    this.homePath = metadata.dataPaths?.home || `~/.${metadata.name}`;
    this.sessionsPath = metadata.dataPaths?.sessions || 'sessions';
  }

  /**
   * Validate that the adapter's data source exists
   * Implementation provided - works for all adapters
   */
  async validateSource(): Promise<boolean> {
    const baseDir = resolvePath(this.homePath);
    return existsSync(baseDir);
  }

  /**
   * Apply pagination to session descriptors
   * Shared helper for subclasses to use in findSessions()
   */
  protected applyPagination(
    descriptors: SessionDescriptor[],
    options?: SessionQueryOptions
  ): SessionDescriptor[] {
    let results = descriptors;

    if (options?.offset) {
      results = results.slice(options.offset);
    }

    if (options?.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  // === Abstract Methods (Agent-Specific) ===

  /**
   * Find all sessions - MUST be implemented by subclass
   * Each agent stores sessions differently
   */
  abstract findSessions(options?: SessionQueryOptions): Promise<SessionDescriptor[]>;

  /**
   * Extract full session - MUST be implemented by subclass
   * Each agent has different session format
   */
  abstract extractSession(descriptor: SessionDescriptor): Promise<CodemieSession>;

  /**
   * Extract messages - MUST be implemented by subclass
   * Each agent has different message format
   */
  abstract extractMessages(descriptor: SessionDescriptor): Promise<CodemieMessage[]>;

  /**
   * Extract tool calls - MUST be implemented by subclass
   * Each agent has different tool call format
   */
  abstract extractToolCalls(descriptor: SessionDescriptor): Promise<CodemieToolCall[]>;

  /**
   * Extract file modifications - MUST be implemented by subclass
   * Each agent has different tool naming
   */
  abstract extractFileModifications(descriptor: SessionDescriptor): Promise<CodemieFileModification[]>;
}
