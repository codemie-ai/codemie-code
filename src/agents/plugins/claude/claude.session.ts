/**
 * Claude Session Adapter
 *
 * Parses Claude Code session files from ~/.claude/projects/
 * Extracts metrics and preserves messages for processors.
 */

import { join, dirname, basename } from 'path';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import type { SessionAdapter, ParsedSession, AggregatedResult } from '../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext } from '../../core/session/BaseProcessor.js';
import type { ClaudeMessage, ContentItem } from './claude-message-types.js';
import type { AgentMetadata } from '../../core/types.js';
import { readJSONL } from '../../core/session/utils/jsonl-reader.js';
import { logger } from '../../../utils/logger.js';
import { MetricsProcessor } from './session/processors/claude.metrics-processor.js';
import { ConversationsProcessor } from './session/processors/claude.conversations-processor.js';

/**
 * Claude session adapter implementation.
 * Parses Claude-specific JSONL format into unified ParsedSession.
 * Orchestrates multiple processors that transform messages.
 *
 * ENCAPSULATION: Processors are managed internally, not exposed to plugin.
 */
export class ClaudeSessionAdapter implements SessionAdapter {
  readonly agentName = 'claude';
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    if (!metadata.dataPaths?.home) {
      throw new Error('Agent metadata must provide dataPaths.home');
    }

    // Initialize and register processors internally
    // Processors run in priority order: metrics (1), conversations (2)
    this.initializeProcessors();
  }

  /**
   * Initialize processors for this adapter.
   * INTERNAL: Processors are an implementation detail of the adapter.
   */
  private initializeProcessors(): void {
    // Register metrics processor (priority 1)
    this.registerProcessor(new MetricsProcessor());

    // Register conversations processor (priority 2)
    this.registerProcessor(new ConversationsProcessor());

    logger.debug(`[claude-adapter] Initialized ${this.processors.length} processors`);
  }

  /**
   * Parse Claude session file to unified format.
   * Extracts both raw messages (for conversations) and metrics (for metrics processor).
   * CRITICAL: Discovers and parses ALL sub-agent files to avoid duplicate file reading.
   */
  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    try {
      // Read main session JSONL file
      const messages = await readJSONL<ClaudeMessage>(filePath);

      // Handle empty files gracefully (new sessions, in-progress, corrupted files)
      if (messages.length === 0) {
        logger.debug(`[claude-adapter] Session file is empty: ${filePath}`);
        return {
          sessionId,
          agentName: this.metadata.displayName || 'claude',
          metadata: {
            projectPath: filePath,
            createdAt: undefined,
            updatedAt: undefined
          },
          messages: [],
          metrics: {
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            tools: {},
            toolStatus: {},
            fileOperations: []
          }
        };
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

      // CRITICAL: Discover and parse ALL sub-agent files
      const subagentFiles = await this.findSubagentFiles(filePath);
      const subagents: Array<{
        agentId: string;
        slug?: string;
        filePath: string;
        messages: unknown[];
      }> = [];

      for (const subagentFile of subagentFiles) {
        try {
          const subagentMessages = await readJSONL<ClaudeMessage>(subagentFile.filePath);
          subagents.push({
            agentId: subagentFile.agentId,
            filePath: subagentFile.filePath,
            messages: subagentMessages
          });

          logger.debug(
            `[claude-adapter] Parsed sub-agent ${subagentFile.agentId}: ${subagentMessages.length} messages`
          );
        } catch (error) {
          logger.warn(
            `[claude-adapter] Failed to parse sub-agent file ${subagentFile.filePath}:`,
            error
          );
          // Continue with other sub-agents even if one fails
        }
      }

      logger.debug(
        `[claude-adapter] Parsed session ${sessionId}: ${messages.length} main messages, ` +
        `${subagents.length} sub-agent${subagents.length !== 1 ? 's' : ''}, ` +
        `${metrics.tokens?.input || 0} input tokens, ${metrics.tokens?.output || 0} output tokens`
      );

      return {
        sessionId,
        agentName: this.metadata.displayName || 'claude',
        metadata,
        messages,  // Preserve raw messages for conversations processor
        subagents: subagents.length > 0 ? subagents : undefined, // Include sub-agents if any
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

  /**
   * Find all agent-*.jsonl files in the subagents directory
   * @param sessionFilePath - Path to the main session file
   * @returns Array of sub-agent file info
   */
  private async findSubagentFiles(sessionFilePath: string): Promise<Array<{
    agentId: string;
    filePath: string;
  }>> {
    try {
      const parentDir = dirname(sessionFilePath);
      const filename = basename(sessionFilePath);
      const sessionId = filename.replace('.jsonl', '');

      // Look in {parentDir}/{sessionId}/subagents/
      const subagentsDir = join(parentDir, sessionId, 'subagents');

      if (!existsSync(subagentsDir)) {
        logger.debug(`[claude-adapter] Subagents directory not found: ${subagentsDir}`);
        return [];
      }

      // Find all agent-*.jsonl files
      const files = await readdir(subagentsDir);
      const agentFiles = files
        .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'))
        .map(f => ({
          agentId: f.replace('agent-', '').replace('.jsonl', ''),
          filePath: join(subagentsDir, f)
        }));

      logger.debug(
        `[claude-adapter] Found ${agentFiles.length} sub-agent file${agentFiles.length !== 1 ? 's' : ''} ` +
        `for session ${sessionId}`
      );

      return agentFiles;
    } catch (error) {
      logger.debug(`[claude-adapter] Failed to find sub-agent files:`, error);
      return [];
    }
  }

  /**
   * Register a processor to run during session processing.
   * Processors are sorted by priority (lower runs first).
   */
  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[claude-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
  }

  /**
   * Process session file with all registered processors.
   * Reads file once, passes ParsedSession to all processors.
   *
   * @param filePath - Path to agent session file
   * @param sessionId - CodeMie session ID
   * @param context - Processing context (for processors that need API access)
   * @returns Aggregated results from all processors
   */
  async processSession(
    filePath: string,
    sessionId: string,
    context: ProcessingContext
  ): Promise<AggregatedResult> {
    try {
      logger.debug(`[claude-adapter] Processing session ${sessionId} with ${this.processors.length} processor${this.processors.length !== 1 ? 's' : ''}`);

      // 1. Parse session file once (includes sub-agent discovery)
      const parsedSession = await this.parseSessionFile(filePath, sessionId);

      // 2. Execute processors in priority order
      const processorResults: Record<string, {
        success: boolean;
        message?: string;
        recordsProcessed?: number;
      }> = {};
      const failedProcessors: string[] = [];
      let totalRecords = 0;

      for (const processor of this.processors) {
        try {
          // Check if processor should run
          if (!processor.shouldProcess(parsedSession)) {
            logger.debug(`[claude-adapter] Processor ${processor.name} skipped (shouldProcess returned false)`);
            continue;
          }

          logger.debug(`[claude-adapter] Running processor: ${processor.name}`);

          // Execute processor
          const result = await processor.process(parsedSession, context);

          processorResults[processor.name] = {
            success: result.success,
            message: result.message,
            recordsProcessed: result.metadata?.recordsProcessed as number | undefined
          };

          // Track failures
          if (!result.success) {
            failedProcessors.push(processor.name);
            logger.warn(`[claude-adapter] Processor ${processor.name} failed: ${result.message}`);
          } else {
            logger.debug(`[claude-adapter] Processor ${processor.name} succeeded: ${result.message}`);
          }

          // Accumulate records
          const recordsProcessed = result.metadata?.recordsProcessed as number | undefined;
          if (typeof recordsProcessed === 'number') {
            totalRecords += recordsProcessed;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[claude-adapter] Processor ${processor.name} threw error:`, error);

          processorResults[processor.name] = {
            success: false,
            message: errorMessage
          };
          failedProcessors.push(processor.name);
        }
      }

      // 3. Aggregate results
      const result: AggregatedResult = {
        success: failedProcessors.length === 0,
        processors: processorResults,
        totalRecords,
        failedProcessors
      };

      logger.debug(
        `[claude-adapter] Processing complete: ${result.success ? 'SUCCESS' : 'FAILED'} ` +
        `(${totalRecords} records, ${failedProcessors.length} failed processors)`
      );

      return result;
    } catch (error) {
      logger.error(`[claude-adapter] Session processing failed:`, error);
      throw error;
    }
  }
}
