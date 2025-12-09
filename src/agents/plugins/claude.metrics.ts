/**
 * Claude Metrics Adapter
 *
 * Implements metrics support for Claude Code agent.
 * Handles Claude-specific file formats and parsing logic.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { BaseMetricsAdapter } from '../core/BaseMetricsAdapter.js';
import type { MetricSnapshot } from '../../metrics/types.js';
import { logger } from '../../utils/logger.js';

/**
 * Claude session file format
 */
interface ClaudeSessionFile {
  id: string;
  workingDirectory?: string;
  messages?: Array<{
    role: string;
    content: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  }>;
  tool_calls?: Array<{
    name: string;
    arguments?: unknown;
  }>;
  model?: string;
  timestamp?: number;
}

export class ClaudeMetricsAdapter extends BaseMetricsAdapter {
  // Note: dataPaths now comes from ClaudePluginMetadata passed via constructor

  /**
   * Check if file matches Claude session pattern
   * Pattern: ~/.claude/projects/{hash}/{session-id}.jsonl
   * Note: Claude uses JSONL (JSON Lines) format, not regular JSON
   * Matches both UUID format and agent-* format
   */
  matchesSessionPattern(path: string): boolean {
    return /\.claude\/projects\/[^/]+\/[a-z0-9-]+\.jsonl$/.test(path);
  }

  /**
   * Extract session ID from Claude file path
   * Examples:
   *   ~/.claude/projects/abc123/session-def-456.jsonl → session-def-456
   *   ~/.claude/projects/abc123/agent-abc123de.jsonl → agent-abc123de
   */
  extractSessionId(path: string): string {
    const match = path.match(/([a-z0-9-]+)\.jsonl$/);
    return match?.[1] || '';
  }

  /**
   * Parse Claude session file (JSONL format) and extract metrics
   * Each line contains a conversation turn with message data
   */
  async parseSessionFile(path: string): Promise<MetricSnapshot> {
    try {
      const content = await readFile(path, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());

      if (lines.length === 0) {
        throw new Error('Empty session file');
      }

      // Parse first line to get session metadata
      const firstLine = JSON.parse(lines[0]);
      const sessionId = firstLine.sessionId || '';
      const workingDirectory = firstLine.cwd || '';

      // Aggregate metrics from all lines
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreationTokens = 0;
      let cacheReadTokens = 0;
      let model: string | undefined;
      const toolCallCounts = new Map<string, number>();

      for (const line of lines) {
        const turn = JSON.parse(line);

        // Extract model (use first non-null model found)
        if (!model && turn.message?.model) {
          model = turn.message.model;
        }

        // Aggregate token usage
        if (turn.message?.usage) {
          const usage = turn.message.usage;
          inputTokens += usage.input_tokens || 0;
          outputTokens += usage.output_tokens || 0;
          cacheCreationTokens += usage.cache_creation_input_tokens || 0;
          cacheReadTokens += usage.cache_read_input_tokens || 0;
        }

        // Count tool calls (if present in content)
        if (turn.message?.content) {
          const contentStr = JSON.stringify(turn.message.content);
          // Look for common tool names in content
          const toolPatterns = ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob'];
          for (const toolName of toolPatterns) {
            const count = (contentStr.match(new RegExp(toolName, 'g')) || []).length;
            if (count > 0) {
              const current = toolCallCounts.get(toolName) || 0;
              toolCallCounts.set(toolName, current + count);
            }
          }
        }
      }

      // Calculate cost (including cache tokens)
      const cost = this.calculateCost(inputTokens + cacheCreationTokens, outputTokens, model);

      const snapshot: MetricSnapshot = {
        sessionId,
        timestamp: Date.now(),

        tokens: {
          input: inputTokens,
          output: outputTokens,
          cacheCreation: cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
          cacheRead: cacheReadTokens > 0 ? cacheReadTokens : undefined
        },

        cost,

        toolCalls: Array.from(toolCallCounts.entries()).map(([name, count]) => ({
          name,
          count
        })),

        turnCount: lines.length,
        model,

        metadata: {
          workingDirectory,
          totalInputTokens: inputTokens + cacheCreationTokens + cacheReadTokens
        }
      };

      logger.debug(`[ClaudeMetrics] Parsed session ${sessionId}: ${inputTokens} input, ${outputTokens} output, ${cacheReadTokens} cache read tokens`);

      return snapshot;
    } catch (error) {
      logger.error(`[ClaudeMetrics] Failed to parse session file: ${path}`, error);
      throw error;
    }
  }

  /**
   * Calculate cost based on tokens and model
   * TODO: Update with actual pricing
   */
  private calculateCost(inputTokens: number, outputTokens: number, model?: string): number {
    // Example pricing (per 1K tokens)
    // Adjust these based on actual Claude pricing
    const prices: Record<string, { input: number; output: number }> = {
      'claude-3-5-sonnet': { input: 0.003, output: 0.015 },
      'claude-3-opus': { input: 0.015, output: 0.075 },
      'claude-3-sonnet': { input: 0.003, output: 0.015 },
      'claude-3-haiku': { input: 0.00025, output: 0.00125 }
    };

    // Default to Sonnet pricing
    const pricing = model && prices[model] ? prices[model] : prices['claude-3-5-sonnet'];

    const inputCost = (inputTokens / 1000) * pricing.input;
    const outputCost = (outputTokens / 1000) * pricing.output;

    return inputCost + outputCost;
  }

  /**
   * Claude uses hash-based watermark (full file rewrite)
   */
  getWatermarkStrategy(): 'hash' | 'line' | 'object' {
    return 'hash';
  }

  /**
   * Claude initialization delay: 500ms
   */
  getInitDelay(): number {
    return 500;
  }
}
