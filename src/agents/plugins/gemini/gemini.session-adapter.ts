/**
 * Gemini Session Adapter
 *
 * Parses Gemini CLI session files from ~/.gemini/tmp/{hash}/chats/
 * Extracts metrics and preserves messages for processors.
 *
 * Key differences from Claude:
 * - JSON format (not JSONL) - single object with messages array
 * - 5 token fields: input, output, cached, thoughts, tool
 * - Self-contained tool calls (not separate tool_use/tool_result messages)
 * - Session metadata at root level (sessionId, projectHash, timestamps)
 */

import { readFile } from 'fs/promises';
import type { SessionAdapter, ParsedSession, AggregatedResult } from '../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext } from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { GeminiMetricsProcessor } from './session/processors/gemini.metrics-processor.js';
import { GeminiConversationsProcessor } from './session/processors/gemini.conversations-processor.js';

/**
 * Gemini session file structure (JSON, not JSONL)
 */
interface GeminiSessionFile {
  sessionId: string;
  projectHash: string;
  startTime: string;       // ISO 8601
  lastUpdated: string;     // ISO 8601
  messages: GeminiMessage[];
}

/**
 * Gemini message structure
 */
interface GeminiMessage {
  id: string;
  timestamp: string;
  type: 'user' | 'gemini';
  content: string;
  toolCalls?: GeminiToolCall[];
  thoughts?: string[];
  model?: string;
  tokens?: {
    input: number;
    output: number;
    cached: number;      // Cache hits (maps to cacheRead)
    thoughts: number;    // Internal reasoning tokens (Gemini-specific)
    tool: number;        // Tool processing tokens (Gemini-specific)
    total: number;
  };
}

/**
 * Gemini tool call structure (self-contained with request + response)
 */
interface GeminiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: Array<{
    functionResponse: {
      id: string;
      name: string;
      response: {
        output: string;
      };
    };
  }>;
  status: 'success' | 'error';
  timestamp: string;
  displayName?: string;
  description?: string;
  renderOutputAsMarkdown?: boolean;
}

/**
 * Gemini session adapter implementation.
 * Parses Gemini-specific JSON format into unified ParsedSession.
 * Orchestrates multiple processors that transform messages.
 */
export class GeminiSessionAdapter implements SessionAdapter {
  readonly agentName = 'gemini';
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
   * Uses Gemini-specific processors that understand Gemini's message format
   */
  private initializeProcessors(): void {
    // Register Gemini metrics processor (priority 1)
    this.registerProcessor(new GeminiMetricsProcessor());

    // Register Gemini conversations processor (priority 2)
    this.registerProcessor(new GeminiConversationsProcessor());

    logger.debug(`[gemini-adapter] Initialized ${this.processors.length} processors`);
  }

  /**
   * Parse Gemini session file to unified format.
   * Reads JSON file (not JSONL) and extracts both raw messages and metrics.
   */
  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    try {
      // Read JSON file
      const content = await readFile(filePath, 'utf-8');
      const sessionData: GeminiSessionFile = JSON.parse(content);

      // Handle empty message array gracefully
      if (!sessionData.messages || sessionData.messages.length === 0) {
        logger.debug(`[gemini-adapter] Session file has no messages: ${filePath}`);
        return {
          sessionId,
          agentName: this.metadata.displayName || 'gemini',
          agentSessionId: sessionData.sessionId,  // Store agent-specific session ID
          metadata: {
            projectPath: filePath,
            createdAt: sessionData.startTime,
            updatedAt: sessionData.lastUpdated
          },
          messages: [],
          metrics: {
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            tools: {},
            toolStatus: {},
            fileOperations: []
          }
        } as ParsedSession;
      }

      // Extract session metadata
      const metadata = {
        projectPath: filePath,
        createdAt: sessionData.startTime,
        updatedAt: sessionData.lastUpdated
      };

      // Extract metrics from messages
      const metrics = this.extractMetrics(sessionData.messages);

      logger.debug(
        `[gemini-adapter] Parsed session ${sessionId}: ${sessionData.messages.length} messages, ` +
        `${metrics.tokens?.input || 0} input tokens, ${metrics.tokens?.output || 0} output tokens, ` +
        `${metrics.tokens?.cacheRead || 0} cached tokens`
      );

      return {
        sessionId,
        agentName: this.metadata.displayName || 'gemini',
        agentSessionId: sessionData.sessionId,  // Store agent-specific session ID
        metadata,
        messages: sessionData.messages,  // Preserve raw messages for conversations processor
        metrics    // Extracted metrics for metrics processor
      } as ParsedSession;

    } catch (error) {
      logger.error(`[gemini-adapter] Failed to parse session file ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Extract metrics data from Gemini messages.
   * Aggregates tokens (5 fields), tools, and file operations.
   *
   * Token mapping strategy (from tech spec):
   * - input → input (direct)
   * - output → output (direct)
   * - cached → cacheRead (semantic match)
   * - cacheWrite → 0 (not available in Gemini)
   * - thoughts, tool → stored in metadata (Gemini-specific)
   */
  private extractMetrics(messages: GeminiMessage[]) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    // Note: Gemini-specific token fields (thoughts, tool) are tracked but not included
    // in the unified metrics format. They could be added to metadata if needed later.

    const toolCounts: Record<string, number> = {};
    const toolStatus: Record<string, { success: number; failure: number }> = {};
    const fileOperations: Array<{
      type: 'write' | 'edit' | 'delete';
      path: string;
    }> = [];

    // Aggregate metrics from all messages
    for (const msg of messages) {
      // Extract token usage (Gemini has 5 fields)
      if (msg.tokens) {
        inputTokens += msg.tokens.input || 0;
        outputTokens += msg.tokens.output || 0;
        cachedTokens += msg.tokens.cached || 0;
        // thoughts and tool tokens are Gemini-specific and not mapped to unified format
      }

      // Extract tool usage and status from self-contained toolCalls
      if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
        for (const tool of msg.toolCalls) {
          // Count tool usage
          toolCounts[tool.name] = (toolCounts[tool.name] || 0) + 1;

          // Initialize status tracking
          if (!toolStatus[tool.name]) {
            toolStatus[tool.name] = { success: 0, failure: 0 };
          }

          // Track success/failure based on status field
          if (tool.status === 'success') {
            toolStatus[tool.name].success++;
          } else if (tool.status === 'error') {
            toolStatus[tool.name].failure++;
          }

          // Extract file operations from tool arguments
          if (tool.args) {
            this.extractFileOperation(tool.name, tool.args, fileOperations);
          }
        }
      }
    }

    return {
      tokens: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: cachedTokens,  // Map Gemini's "cached" to "cacheRead"
        cacheWrite: 0              // Not available in Gemini
        // Note: thoughts and tool tokens stored separately if needed
      },
      tools: toolCounts,
      toolStatus,
      fileOperations
    };
  }

  /**
   * Extract file operation from tool arguments
   */
  private extractFileOperation(
    toolName: string,
    args: Record<string, unknown>,
    operations: Array<{ type: 'write' | 'edit' | 'delete'; path: string }>
  ): void {
    const filePath = args.file_path as string | undefined;
    if (!filePath) return;

    // Map tool names to operation types
    const toolToOpType: Record<string, 'write' | 'edit' | 'delete'> = {
      'write_file': 'write',
      'replace': 'edit',
      'edit_file': 'edit',
      // Add more mappings as needed
    };

    const opType = toolToOpType[toolName];
    if (opType) {
      operations.push({ type: opType, path: filePath });
    }
  }

  /**
   * Register a processor to run during session processing.
   * Processors are sorted by priority (lower runs first).
   */
  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[gemini-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
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
      logger.debug(`[gemini-adapter] Processing session ${sessionId} with ${this.processors.length} processor${this.processors.length !== 1 ? 's' : ''}`);

      // 1. Parse session file once
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
            logger.debug(`[gemini-adapter] Processor ${processor.name} skipped (shouldProcess returned false)`);
            continue;
          }

          logger.debug(`[gemini-adapter] Running processor: ${processor.name}`);

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
            logger.warn(`[gemini-adapter] Processor ${processor.name} failed: ${result.message}`);
          } else {
            logger.debug(`[gemini-adapter] Processor ${processor.name} succeeded: ${result.message}`);
          }

          // Accumulate records
          const recordsProcessed = result.metadata?.recordsProcessed as number | undefined;
          if (typeof recordsProcessed === 'number') {
            totalRecords += recordsProcessed;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[gemini-adapter] Processor ${processor.name} threw error:`, error);

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
        `[gemini-adapter] Processing complete: ${result.success ? 'SUCCESS' : 'FAILED'} ` +
        `(${totalRecords} records, ${failedProcessors.length} failed processors)`
      );

      return result;
    } catch (error) {
      logger.error(`[gemini-adapter] Session processing failed:`, error);
      throw error;
    }
  }
}
