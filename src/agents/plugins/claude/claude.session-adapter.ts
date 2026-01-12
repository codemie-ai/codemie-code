/**
 * Claude Session Adapter
 *
 * Parses Claude Code session files from ~/.claude/projects/
 * Extracts metrics and preserves messages for processors.
 */

import { join } from 'path';
import { homedir } from 'os';
import type { SessionAdapter, ParsedSession } from '../../../providers/plugins/sso/session/adapters/base/BaseSessionAdapter.js';
import type { ClaudeMessage, ContentItem } from './claude-message-types.js';
import type { AgentMetadata } from '../../core/types.js';
import { readJSONL } from '../../../providers/plugins/sso/session/utils/jsonl-reader.js';
import { logger } from '../../../utils/logger.js';

/**
 * Claude session adapter implementation.
 * Parses Claude-specific JSONL format into unified ParsedSession.
 */
export class ClaudeSessionAdapter implements SessionAdapter {
  readonly agentName = 'claude';

  constructor(private readonly metadata: AgentMetadata) {
    if (!metadata.dataPaths?.home || !metadata.dataPaths?.sessions) {
      throw new Error('Agent metadata must provide dataPaths.home and dataPaths.sessions');
    }
  }

  /**
   * Get Claude session storage paths.
   * Sessions are stored in ~/.claude/projects/{projectId}/{sessionId}.jsonl
   * Uses metadata from agent plugin
   */
  getSessionPaths(): { baseDir: string; projectDirs?: string[] } {
    // Safe to use non-null assertions - validated in constructor
    const home = this.metadata.dataPaths!.home!; // '.claude'
    const sessions = this.metadata.dataPaths!.sessions!; // 'projects'

    return {
      baseDir: join(homedir(), home, sessions)
    };
  }

  /**
   * Check if file matches Claude session pattern.
   * Matches: UUID.jsonl (excludes agent-*.jsonl)
   */
  matchesSessionPattern(filePath: string): boolean {
    const filename = filePath.split(/[\\/]/).pop();
    if (!filename) return false;

    return filename.endsWith('.jsonl') && !filename.startsWith('agent-');
  }

  /**
   * Parse Claude session file to unified format.
   * Extracts both raw messages (for conversations) and metrics (for metrics processor).
   */
  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    try {
      // Read JSONL file
      const messages = await readJSONL<ClaudeMessage>(filePath);

      if (messages.length === 0) {
        throw new Error('Session file is empty or has no valid messages');
      }

      // Extract timestamps from first/last messages that have them
      let createdAt: string | undefined;
      let updatedAt: string | undefined;

      // Find first message with timestamp
      for (const message of messages) {
        if (message.timestamp) {
          createdAt = message.timestamp;
          break;
        }
      }

      // Find last message with timestamp (iterate backwards)
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].timestamp) {
          updatedAt = messages[i].timestamp;
          break;
        }
      }

      // Extract metadata from session
      const metadata = {
        projectPath: filePath,
        createdAt,
        updatedAt
      };

      // Extract metrics from messages
      const metrics = this.extractMetrics(messages);

      logger.debug(
        `[claude-adapter] Parsed session ${sessionId}: ${messages.length} messages, ` +
        `${metrics.tokens?.input || 0} input tokens, ${metrics.tokens?.output || 0} output tokens`
      );

      return {
        sessionId,
        agentName: 'claude',
        metadata,
        messages,  // Preserve raw messages for conversations processor
        metrics    // Extracted metrics for metrics processor
      };

    } catch (error) {
      logger.error(`[claude-adapter] Failed to parse session file ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Extract metrics data from Claude messages.
   * Aggregates tokens, tools, and file operations.
   */
  private extractMetrics(messages: ClaudeMessage[]) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;

    const toolCounts: Record<string, number> = {};
    const toolStatus: Record<string, { success: number; failure: number }> = {};
    const fileOperations: Array<{
      type: 'write' | 'edit' | 'delete';
      path: string;
      linesAdded?: number;
      linesRemoved?: number;
    }> = [];

    // Build tool results map (tool_use_id → isError) for status tracking
    const toolResultsMap = new Map<string, boolean>();

    // First pass: collect tool results
    for (const msg of messages) {
      if (msg.message?.content && Array.isArray(msg.message.content)) {
        for (const item of msg.message.content as ContentItem[]) {
          // Map tool_use_id to error status
          if (item.type === 'tool_result' && item.tool_use_id) {
            const isError = (item as any).is_error === true || item.isError === true;
            toolResultsMap.set(item.tool_use_id, isError);
          }
        }
      }
    }

    // Second pass: aggregate metrics
    for (const msg of messages) {
      // Extract token usage
      if (msg.message?.usage) {
        const usage = msg.message.usage;
        inputTokens += usage.input_tokens || 0;
        outputTokens += usage.output_tokens || 0;
        cacheReadTokens += usage.cache_read_input_tokens || 0;
        cacheWriteTokens += usage.cache_creation_input_tokens || 0;
      }

      // Extract tool usage and status
      if (msg.message?.content && Array.isArray(msg.message.content)) {
        for (const item of msg.message.content as ContentItem[]) {
          if (item.type === 'tool_use' && item.name && item.id) {
            // Count tool usage
            toolCounts[item.name] = (toolCounts[item.name] || 0) + 1;

            // Initialize status tracking
            if (!toolStatus[item.name]) {
              toolStatus[item.name] = { success: 0, failure: 0 };
            }

            // Track success/failure based on result
            const hasResult = toolResultsMap.has(item.id);
            if (hasResult) {
              const isError = toolResultsMap.get(item.id);
              if (isError) {
                toolStatus[item.name].failure++;
              } else {
                toolStatus[item.name].success++;
              }
            }
          }
        }
      }

      // Extract file operations from tool results
      if (msg.toolUseResult?.type) {
        const toolType = msg.toolUseResult.type.toLowerCase();
        const filePath = msg.toolUseResult.file?.filePath;

        if (filePath) {
          if (toolType === 'write') {
            fileOperations.push({ type: 'write', path: filePath });
          } else if (toolType === 'edit') {
            fileOperations.push({ type: 'edit', path: filePath });
          } else if (toolType === 'delete') {
            fileOperations.push({ type: 'delete', path: filePath });
          }
        }
      }
    }

    return {
      tokens: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens
      },
      tools: toolCounts,
      toolStatus,
      fileOperations
    };
  }
}
