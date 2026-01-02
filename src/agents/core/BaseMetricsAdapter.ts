/**
 * Base Metrics Adapter
 *
 * Generic implementation of AgentMetricsSupport interface.
 * Provides default implementations that work for most agents.
 * Agent plugins override only what's specific to them.
 */

import { join, extname } from 'path';
import { resolveHomeDir, splitPath } from '../../utils/paths.js';
import type {
  AgentMetricsSupport,
  MetricSnapshot,
  MetricDelta,
  UserPrompt,
  ToolCallMetric,
  ToolUsageSummary
} from './metrics/types.js';
import type { AgentMetadata } from './types.js';

export abstract class BaseMetricsAdapter implements AgentMetricsSupport {
  constructor(
    protected agentName: string,
    protected metadata?: AgentMetadata
  ) {}

  /**
   * Get agent home directory (e.g., ~/.claude, ~/.codex, ~/.gemini)
   * @returns Absolute path to agent home directory
   */
  protected getHomeDir(): string {
    if (!this.metadata?.dataPaths?.home) {
      throw new Error(`${this.agentName}: metadata.dataPaths.home is not defined`);
    }
    return resolveHomeDir(this.metadata.dataPaths.home);
  }

  /**
   * Get sessions directory path
   * @returns Absolute path to sessions directory
   */
  protected getSessionsDir(): string {
    const home = this.getHomeDir();
    const sessions = this.metadata?.dataPaths?.sessions || '';
    return join(home, sessions);
  }

  /**
   * Get user prompts file path
   * @returns Absolute path to user prompts history file
   */
  protected getUserPromptsPath(): string {
    if (!this.metadata?.dataPaths?.user_prompts) {
      throw new Error(`${this.agentName}: metadata.dataPaths.user_prompts is not defined`);
    }
    const home = this.getHomeDir();
    return join(home, this.metadata.dataPaths.user_prompts);
  }

  /**
   * Get settings file path
   * @returns Absolute path to settings file
   */
  protected getSettingsPath(): string {
    if (!this.metadata?.dataPaths?.settings) {
      throw new Error(`${this.agentName}: metadata.dataPaths.settings is not defined`);
    }
    const home = this.getHomeDir();
    return join(home, this.metadata.dataPaths.settings);
  }

  /**
   * Get data paths - can be overridden or uses metadata.dataPaths
   */
  getDataPaths(): {
    sessionsDir: string;
    settingsDir?: string;
  } {
    if (this.metadata?.dataPaths) {
      return {
        sessionsDir: this.getSessionsDir(),
        settingsDir: this.getHomeDir()
      };
    }

    // Fallback: must be overridden
    throw new Error(`${this.agentName}: getDataPaths() must be implemented or metadata.dataPaths must be provided`);
  }

  /**
   * Check if file matches session pattern - MUST be overridden
   */
  abstract matchesSessionPattern(path: string): boolean;

  /**
   * Extract session ID from path - MUST be overridden
   */
  abstract extractSessionId(path: string): string;

  /**
   * Parse session file - MUST be overridden
   */
  abstract parseSessionFile(path: string): Promise<MetricSnapshot>;

  /**
   * Parse incremental metrics from session file
   * Returns only new deltas, skipping already-processed record IDs
   * MUST be overridden if delta-based metrics are used
   */
  async parseIncrementalMetrics(
    _path: string,
    _processedRecordIds: Set<string>,
    _attachedUserPromptTexts?: Set<string>
  ): Promise<{
    deltas: MetricDelta[];
    lastLine: number;
    newlyAttachedPrompts?: string[];
  }> {
    // Default implementation: not supported
    throw new Error(`${this.agentName}: parseIncrementalMetrics() not implemented`);
  }

  /**
   * Get user prompts for a specific session
   * Each agent implements this to parse their specific history format
   * MUST be overridden by each agent adapter
   */
  async getUserPrompts(
    _sessionId: string,
    _fromTimestamp?: number,
    _toTimestamp?: number
  ): Promise<UserPrompt[]> {
    // Default implementation: not supported
    throw new Error(`${this.agentName}: getUserPrompts() not implemented`);
  }

  /**
   * Get watermark strategy - default: hash
   * Override if agent uses different strategy
   */
  getWatermarkStrategy(): 'hash' | 'line' | 'object' {
    return 'hash'; // Default: full-file hash
  }

  /**
   * Get initialization delay - default: 1000ms
   * Override if agent needs different delay
   */
  getInitDelay(): number {
    return 1000; // Default: 1000ms
  }

  // ==========================================
  // Shared Utility Methods
  // ==========================================

  /**
   * Extract file format/extension from path
   * @param path - File path
   * @returns File extension without dot (e.g., 'ts', 'py') or undefined
   */
  protected extractFormat(path: string): string | undefined {
    const ext = extname(path);
    return ext ? ext.slice(1) : undefined;
  }

  /**
   * Detect programming language from file extension
   * @param path - File path
   * @returns Language name (e.g., 'typescript', 'python') or undefined
   */
  protected detectLanguage(path: string): string | undefined {
    const ext = extname(path).toLowerCase();
    const langMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rs': 'rust',
      '.cpp': 'cpp',
      '.c': 'c',
      '.rb': 'ruby',
      '.php': 'php',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.md': 'markdown',
      '.json': 'json',
      '.yaml': 'yaml',
      '.yml': 'yaml'
    };
    return langMap[ext];
  }

  /**
   * Build aggregated tool usage summary from detailed tool calls
   * Aggregates: count, success/error counts, file operation type counts
   * @param toolCalls - Array of detailed tool call metrics
   * @returns Array of aggregated summaries per tool
   */
  protected buildToolUsageSummary(toolCalls: ToolCallMetric[]): ToolUsageSummary[] {
    const summaryMap = new Map<string, ToolUsageSummary>();

    for (const call of toolCalls) {
      let summary = summaryMap.get(call.name);
      if (!summary) {
        summary = {
          name: call.name,
          count: 0,
          successCount: 0,
          errorCount: 0,
          fileOperations: {}
        };
        summaryMap.set(call.name, summary);
      }

      summary.count++;
      if (call.status === 'success') {
        summary.successCount!++;
      } else if (call.status === 'error') {
        summary.errorCount!++;
      }

      // Aggregate file operations by type
      if (call.fileOperation) {
        const opType = call.fileOperation.type;
        summary.fileOperations![opType] = (summary.fileOperations![opType] || 0) + 1;
      }
    }

    return Array.from(summaryMap.values());
  }

  // ==========================================
  // Template-Based Path Matching
  // ==========================================

  /**
   * Parse sessions path template into segments
   * Handles both static segments and dynamic placeholders
   *
   * @returns Array of path segments
   *
   * @example
   * // Claude: 'projects' → ['projects']
   * parseSessionsTemplate()
   *
   * @example
   * // Gemini: 'tmp/{projectHash}/chats' → ['tmp', '{projectHash}', 'chats']
   * parseSessionsTemplate()
   */
  protected parseSessionsTemplate(): string[] {
    if (!this.metadata?.dataPaths?.sessions) {
      return [];
    }
    return this.metadata.dataPaths.sessions.split('/').filter(Boolean);
  }

  /**
   * Check if a segment is a dynamic placeholder
   * Placeholders are enclosed in curly braces: {placeholderName}
   *
   * @param segment - Path segment to check
   * @returns true if segment is a dynamic placeholder
   *
   * @example
   * isDynamicSegment('{projectHash}') // Returns: true
   * isDynamicSegment('tmp')           // Returns: false
   */
  protected isDynamicSegment(segment: string): boolean {
    return segment.startsWith('{') && segment.endsWith('}');
  }

  /**
   * Validate that a path matches the sessions template structure
   * Handles both static segments (must match exactly) and dynamic placeholders (any value)
   *
   * Cross-platform: uses splitPath() which normalizes separators
   *
   * @param path - File path to validate
   * @returns true if path matches template structure
   *
   * @example
   * // Gemini with sessions: 'tmp/{projectHash}/chats'
   * matchesSessionsStructure('~/.gemini/tmp/abc123/chats/session.json')
   * // Returns: true (tmp=static, abc123=dynamic, chats=static)
   *
   * @example
   * // Claude with sessions: 'projects'
   * matchesSessionsStructure('~/.claude/projects/hash/file.jsonl')
   * // Returns: true (projects=static)
   */
  protected matchesSessionsStructure(path: string): boolean {
    if (!this.metadata?.dataPaths?.home) {
      return false;
    }

    const baseDir = this.metadata.dataPaths.home;
    const sessionsParts = this.parseSessionsTemplate();

    if (sessionsParts.length === 0) {
      return false;
    }

    // Split path using cross-platform utility
    const parts = splitPath(path);
    const baseIndex = parts.findIndex(p => p === baseDir);

    if (baseIndex === -1) {
      return false;
    }

    // Validate each segment in template
    for (let i = 0; i < sessionsParts.length; i++) {
      const expectedSegment = sessionsParts[i];
      const actualSegment = parts[baseIndex + 1 + i];

      if (!actualSegment) {
        return false; // Missing segment
      }

      // Skip validation for dynamic placeholders (any value accepted)
      if (this.isDynamicSegment(expectedSegment)) {
        continue;
      }

      // Validate static segments (must match exactly)
      if (actualSegment !== expectedSegment) {
        return false;
      }
    }

    return true;
  }

  /**
   * Extract value of a dynamic placeholder from path
   * Finds placeholder in sessions template and extracts corresponding value from path
   *
   * @param path - File path containing placeholder value
   * @param placeholderName - Name of placeholder (without braces)
   * @returns Extracted value or null if placeholder not found
   *
   * @example
   * // Gemini with sessions: 'tmp/{projectHash}/chats'
   * extractPlaceholder('~/.gemini/tmp/abc123/chats/file.json', 'projectHash')
   * // Returns: 'abc123'
   *
   * @example
   * // Claude has no placeholders
   * extractPlaceholder('~/.claude/projects/hash/file.jsonl', 'hash')
   * // Returns: null (no {hash} placeholder in template)
   */
  protected extractPlaceholder(path: string, placeholderName: string): string | null {
    const sessionsParts = this.parseSessionsTemplate();
    const baseDir = this.metadata?.dataPaths?.home;

    if (!baseDir) {
      return null;
    }

    // Find placeholder index in template
    // Example: ['tmp', '{projectHash}', 'chats'] → index 1 for 'projectHash'
    const placeholderIndex = sessionsParts.findIndex(
      part => part === `{${placeholderName}}`
    );

    if (placeholderIndex === -1) {
      return null; // Placeholder not in template
    }

    // Extract value at that position in path
    const parts = splitPath(path);
    const baseIndex = parts.findIndex(p => p === baseDir);

    if (baseIndex === -1) {
      return null;
    }

    const valueIndex = baseIndex + 1 + placeholderIndex;
    return parts[valueIndex] || null;
  }
}
