/**
 * User Prompt Source - Core Abstraction
 *
 * Provides a unified interface for reading user prompt history files
 * across different AI coding agents. Each agent maintains lightweight
 * history files tracking actual user input (what users typed), distinct
 * from full session interaction logs.
 *
 * This abstraction enables:
 * - Accurate user engagement metrics (true user prompts vs system messages)
 * - Session coverage (include sessions without full logs)
 * - Automation insights (ratio of AI-generated to user-initiated messages)
 */

/**
 * Represents a user prompt
 */
export interface UserPrompt {
  /** User's actual input text */
  prompt: string;

  /** Timestamp of the prompt */
  timestamp: Date;

  /** Session ID this prompt belongs to */
  sessionId: string;

  /** Project path (optional) */
  projectPath?: string;

  /** Additional metadata (pasted content, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for user prompt source
 */
export interface UserPromptSourceConfig {
  /** Path to user prompt file(s) - supports glob patterns */
  filePath: string | string[];

  /** Type of file format (jsonl, json, csv, etc.) */
  format: 'jsonl' | 'json' | 'csv' | 'custom';

  /** Custom parser function for non-standard formats */
  parser?: (content: string) => UserPrompt[];
}

/**
 * Options for filtering prompts
 */
export interface PromptQueryOptions {
  /** Filter by date range (start) */
  dateFrom?: Date;

  /** Filter by date range (end) */
  dateTo?: Date;

  /** Filter by session ID */
  sessionId?: string;
}

/**
 * Abstract base for user prompt sources
 *
 * Provides common functionality for reading and filtering user prompts
 * from various file formats. Subclasses implement format-specific parsing.
 */
export abstract class UserPromptSource {
  constructor(protected config: UserPromptSourceConfig) {}

  /**
   * Read all user prompts from source
   * @param options - Optional filtering (dateFrom, dateTo, sessionId)
   */
  abstract readPrompts(options?: PromptQueryOptions): Promise<UserPrompt[]>;

  /**
   * Group prompts by session ID
   * Common utility used by adapters to organize prompts
   */
  async groupBySession(
    options?: PromptQueryOptions
  ): Promise<Map<string, UserPrompt[]>> {
    const prompts = await this.readPrompts(options);
    const grouped = new Map<string, UserPrompt[]>();

    for (const prompt of prompts) {
      const sessionPrompts = grouped.get(prompt.sessionId) || [];
      sessionPrompts.push(prompt);
      grouped.set(prompt.sessionId, sessionPrompts);
    }

    return grouped;
  }

  /**
   * Count prompts per session
   * Used to calculate accurate user engagement metrics
   */
  async countBySession(
    options?: PromptQueryOptions
  ): Promise<Map<string, number>> {
    const grouped = await this.groupBySession(options);
    const counts = new Map<string, number>();

    for (const [sessionId, prompts] of grouped) {
      counts.set(sessionId, prompts.length);
    }

    return counts;
  }

  /**
   * Apply standard filters to prompts
   * Protected helper for subclasses to reuse
   */
  protected applyFilters(
    prompts: UserPrompt[],
    options?: PromptQueryOptions
  ): UserPrompt[] {
    let filtered = prompts;

    if (options?.dateFrom) {
      filtered = filtered.filter(p => p.timestamp >= options.dateFrom!);
    }

    if (options?.dateTo) {
      filtered = filtered.filter(p => p.timestamp <= options.dateTo!);
    }

    if (options?.sessionId) {
      filtered = filtered.filter(p => p.sessionId === options.sessionId);
    }

    return filtered;
  }
}
