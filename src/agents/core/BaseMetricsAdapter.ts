/**
 * Base Metrics Adapter
 *
 * Generic implementation of AgentMetricsSupport interface.
 * Provides default implementations that work for most agents.
 * Agent plugins override only what's specific to them.
 */

import { homedir } from 'os';
import { join, extname } from 'path';
import type {
  AgentMetricsSupport,
  MetricSnapshot,
  MetricDelta,
  UserPrompt,
  ToolCallMetric,
  ToolUsageSummary
} from '../../metrics/types.js';
import type { AgentMetadata } from './types.js';

export abstract class BaseMetricsAdapter implements AgentMetricsSupport {
  constructor(
    protected agentName: string,
    protected metadata?: AgentMetadata
  ) {}

  /**
   * Get data paths - can be overridden or uses metadata.dataPaths
   */
  getDataPaths(): {
    sessionsDir: string;
    settingsDir?: string;
  } {
    if (this.metadata?.dataPaths) {
      // Use dataPaths from metadata
      const home = this.metadata.dataPaths.home;
      const sessions = this.metadata.dataPaths.sessions || '';

      return {
        sessionsDir: join(home.replace('~', homedir()), sessions),
        settingsDir: home.replace('~', homedir())
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
   * Get initialization delay - default: 500ms
   * Override if agent needs different delay
   */
  getInitDelay(): number {
    return 500; // Default: 500ms
  }

  /**
   * Utility: Get agent home directory
   */
  protected getAgentHome(subpath?: string): string {
    const home = homedir();
    const agentDir = join(home, `.${this.agentName}`);
    return subpath ? join(agentDir, subpath) : agentDir;
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
}
