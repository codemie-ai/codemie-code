/**
 * Gemini Metrics Processor
 *
 * Transforms Gemini session messages into metric deltas.
 *
 * Key differences from Claude:
 * - Messages have direct `type` field ('user' | 'gemini'), not nested `message.role`
 * - Content is a string, not an array of content blocks
 * - Tokens are in `tokens` object with 5 fields: input, output, cached, thoughts, tool
 * - Tool calls are self-contained in `toolCalls` array (not separate tool_use/tool_result messages)
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import { logger } from '../../../../../utils/logger.js';
import type { MetricDelta } from '../../../../core/metrics/types.js';
import { extractFormat, detectLanguage } from '../../../../../utils/file-operations.js';

/**
 * Gemini message structure (from gemini.session-adapter.ts)
 */
interface GeminiMessage {
  id: string;
  timestamp: string;
  type: 'user' | 'gemini';
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    status: 'success' | 'error';
    timestamp: string;
    result?: any[];
  }>;
  thoughts?: string[];
  model?: string;
  tokens?: {
    input: number;
    output: number;
    cached: number;
    thoughts: number;
    tool: number;
    total: number;
  };
}

export class GeminiMetricsProcessor implements SessionProcessor {
  readonly name = 'gemini-metrics';
  readonly priority = 1; // Run first

  shouldProcess(session: ParsedSession): boolean {
    return session.messages && session.messages.length > 0;
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    try {
      return await this.processMessages(session, context);
    } catch (error) {
      logger.error(`[${this.name}] Processing failed:`, error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Transform ParsedSession.messages to deltas and write to JSONL
   */
  private async processMessages(
    session: ParsedSession,
    _context: ProcessingContext
  ): Promise<ProcessingResult> {
    try {
      logger.info(`[${this.name}] Transforming ${session.messages.length} messages to deltas`);

      const deltas = this.transformMessagesToDeltas(session);

      if (deltas.length === 0) {
        logger.debug(`[${this.name}] No deltas generated from messages`);
        return { success: true, message: 'No deltas generated', metadata: { recordsProcessed: 0 } };
      }

      const { MetricsWriter } = await import('../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
      const writer = new MetricsWriter(session.sessionId);

      for (const delta of deltas) {
        await writer.appendDelta(delta);
      }

      logger.info(`[${this.name}] Generated and wrote ${deltas.length} deltas`);

      return {
        success: true,
        message: `Generated ${deltas.length} deltas`,
        metadata: { recordsProcessed: deltas.length }
      };

    } catch (error) {
      logger.error(`[${this.name}] Failed to process messages:`, error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Transform Gemini messages to deltas
   */
  private transformMessagesToDeltas(session: ParsedSession): Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> {
    const deltas: Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> = [];
    const messages = session.messages as GeminiMessage[];

    // Track user prompts for attaching to assistant responses
    let lastUserPrompt: string | null = null;

    for (const msg of messages) {
      // Track user prompts
      if (msg.type === 'user') {
        lastUserPrompt = msg.content;
        continue; // User messages don't generate deltas
      }

      // Process assistant (gemini) messages
      if (msg.type === 'gemini') {
        const delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'> = {
          recordId: msg.id,  // Use message ID as recordId
          sessionId: session.sessionId,
          agentSessionId: (session as any).agentSessionId || session.sessionId,  // Fall back to CodeMie sessionId if no agent session
          timestamp: new Date(msg.timestamp).getTime(),
          gitBranch: undefined,  // Gemini doesn't track git branch per message

          // Token usage (from msg.tokens)
          tokens: {
            input: msg.tokens?.input || 0,
            output: msg.tokens?.output || 0,
            cacheRead: msg.tokens?.cached || 0,  // Gemini's 'cached' maps to 'cacheRead'
            cacheCreation: 0  // Not available in Gemini
          },

          // Required field - initialize as empty, populate if tools exist
          tools: {}
        };

        // Add model if available (as array)
        if (msg.model) {
          (delta as any).models = [msg.model];
        }

        // Extract tool usage from toolCalls
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const toolStatus: Record<string, { success: number; failure: number }> = {};
          const fileOperations: Array<{
            type: string;
            path?: string;
            linesAdded?: number;
            linesRemoved?: number;
            format?: string;
            language?: string;
          }> = [];

          for (const tool of msg.toolCalls) {
            // Count tool usage (populate directly on delta.tools)
            delta.tools[tool.name] = (delta.tools[tool.name] || 0) + 1;

            // Track success/failure
            if (!toolStatus[tool.name]) {
              toolStatus[tool.name] = { success: 0, failure: 0 };
            }

            if (tool.status === 'success') {
              toolStatus[tool.name].success++;

              // Extract file operations for successful tool calls
              const fileOp = this.extractFileOperation(tool.name, tool.args, tool.result);
              if (fileOp) {
                fileOperations.push(fileOp);
              }
            } else if (tool.status === 'error') {
              toolStatus[tool.name].failure++;
            }
          }

          // Add toolStatus if we have any
          if (Object.keys(toolStatus).length > 0) {
            (delta as any).toolStatus = toolStatus;
          }

          // Add file operations if we have any
          if (fileOperations.length > 0) {
            (delta as any).fileOperations = fileOperations;
          }
        }

        // Attach user prompt if available
        if (lastUserPrompt) {
          (delta as any).userPrompts = [{
            count: 1,
            text: lastUserPrompt
          }];
        }

        deltas.push(delta);

        // Clear last user prompt after attaching
        lastUserPrompt = null;
      }
    }

    return deltas;
  }

  /**
   * Extract file operation from Gemini tool call
   */
  private extractFileOperation(
    toolName: string,
    args: Record<string, unknown>,
    result?: any[]
  ): { type: string; path?: string; format?: string; language?: string; linesAdded?: number; linesRemoved?: number } | undefined {
    const typeMap: Record<string, string> = {
      'write_file': 'write',
      'Write': 'write',
      'replace': 'edit',
      'edit_file': 'edit',
      'Edit': 'edit',
      'read_file': 'read',
      'Read': 'read',
      'delete_file': 'delete'
    };

    const type = typeMap[toolName];
    if (!type) return undefined;

    const fileOp: any = { type };
    const filePath = args.file_path as string | undefined;

    if (filePath) {
      fileOp.path = filePath;
      fileOp.format = extractFormat(filePath);
      fileOp.language = detectLanguage(filePath);
    }

    // Calculate line counts from tool arguments
    if (toolName === 'write_file' || toolName === 'Write') {
      const content = args.content as string | undefined;
      if (content) {
        const lines = content.split('\n');
        fileOp.linesAdded = lines.length;
      }
    }

    // For edit operations, try to extract line counts from result
    // Note: Gemini result structure may vary, add defensive checks
    if ((toolName === 'replace' || toolName === 'edit_file' || toolName === 'Edit') && result) {
      const output = result[0]?.functionResponse?.response?.output;
      if (typeof output === 'object' && output !== null) {
        if (output.linesAdded !== undefined) {
          fileOp.linesAdded = output.linesAdded;
        }
        if (output.linesRemoved !== undefined) {
          fileOp.linesRemoved = output.linesRemoved;
        }
      }
    }

    return fileOp;
  }
}
