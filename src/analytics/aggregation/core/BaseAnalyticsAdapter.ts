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
import { UserPromptSource, UserPrompt } from './user-prompt-source.js';

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
  protected userPromptSource?: UserPromptSource;

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

  /**
   * Read user prompts from source (optional)
   * Subclasses should set userPromptSource to enable this functionality
   */
  protected async readUserPrompts(
    sessionId: string,
    options?: { dateFrom?: Date; dateTo?: Date }
  ): Promise<UserPrompt[]> {
    if (!this.userPromptSource) {
      return [];
    }

    return this.userPromptSource.readPrompts({
      ...options,
      sessionId
    });
  }

  /**
   * Count user prompts from source (optional)
   * Returns 0 if no user prompt source is configured
   */
  protected async countUserPrompts(
    sessionId: string,
    options?: { dateFrom?: Date; dateTo?: Date }
  ): Promise<number> {
    const prompts = await this.readUserPrompts(sessionId, options);
    return prompts.length;
  }

  /**
   * Calculate user prompt percentage
   * Formula: (userPromptCount / userMessageCount) * 100
   * Returns undefined if userMessageCount is 0
   * Shows what percentage of user messages are actual user prompts
   * Lower percentage = more system-generated messages
   */
  protected calculateUserPromptPercentage(
    userPromptCount: number,
    userMessageCount: number
  ): number | undefined {
    if (userMessageCount === 0) {
      return undefined;
    }
    return (userPromptCount / userMessageCount) * 100;
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
