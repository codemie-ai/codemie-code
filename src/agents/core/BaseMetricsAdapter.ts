/**
 * Base Metrics Adapter
 *
 * Generic implementation of AgentMetricsSupport interface.
 * Provides default implementations that work for most agents.
 * Agent plugins override only what's specific to them.
 */

import { homedir } from 'os';
import { join } from 'path';
import type { AgentMetricsSupport, MetricSnapshot, MetricDelta, UserPrompt } from '../../metrics/types.js';
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
    _processedRecordIds: Set<string>
  ): Promise<{
    deltas: MetricDelta[];
    lastLine: number;
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
}
