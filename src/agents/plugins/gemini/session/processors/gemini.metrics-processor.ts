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
 * Strip <session_context>...</session_context> blocks and trim the result.
 */
function filterSessionContext(text: string): string | null {
  const cleaned = text.replace(/<session_context>[\s\S]*?<\/session_context>/gi, '').trim();
  return cleaned || null;
}

/**
 * Extract user prompt text from varied content formats.
 */
function extractPromptText(content: unknown): string | null {
  if (typeof content === 'string') {
    return filterSessionContext(content);
  }
  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean);
    if (textParts.length > 0) {
      return filterSessionContext(textParts.join('\n'));
    }
  }
  return null;
}

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

      const deltas = this.transformMessagesToDeltas(session, _context);

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
  private transformMessagesToDeltas(
    session: ParsedSession,
    context?: ProcessingContext
  ): Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> {
    const deltas: Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> = [];
    const messages = session.messages as GeminiMessage[];

    // Track user prompts for attaching to assistant responses
    let lastUserPrompt: string | null = null;
    const gitBranch = context?.gitBranch ?? (session.metadata as any)?.gitBranch;

    for (const msg of messages) {
      // Track user prompts
      if (msg.type === 'user') {
        lastUserPrompt = extractPromptText(msg.content);
        continue; // User messages don't generate deltas
      }

      // Process assistant (gemini or assistant) messages
      if (msg.type === 'gemini' || (msg.type as string) === 'assistant') {
        const delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'> = {
          recordId: msg.id,  // Use message ID as recordId
          sessionId: session.sessionId,
          agentSessionId: (session as any).agentSessionId || session.sessionId,  // Fall back to CodeMie sessionId if no agent session
          timestamp: new Date(msg.timestamp).getTime(),
          ...(gitBranch && { gitBranch }),

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

          if (!delta.tools) {
            delta.tools = {};
          }

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
    const writeTools = new Set(['create_text_file', 'mcp_serena_create_text_file', 'mcp_serena_write_file', 'write_file', 'Write', 'write_to_file']);
    const editTools = new Set([
      'replace_content', 'mcp_serena_replace_content', 'replace_in_files', 'mcp_serena_replace_in_files',
      'replace_symbol_body', 'mcp_serena_replace_symbol_body', 'insert_after_symbol', 'mcp_serena_insert_after_symbol',
      'insert_before_symbol', 'mcp_serena_insert_before_symbol', 'safe_delete_symbol', 'mcp_serena_safe_delete_symbol',
      'replace_file_content', 'replace', 'edit_file', 'Edit'
    ]);
    const readTools = new Set(['read_file', 'Read', 'mcp_serena_read_file', 'view_file']);
    const deleteTools = new Set(['delete_file']);

    let type: string | undefined;
    if (writeTools.has(toolName)) type = 'write';
    else if (editTools.has(toolName)) type = 'edit';
    else if (readTools.has(toolName)) type = 'read';
    else if (deleteTools.has(toolName)) type = 'delete';

    if (!type) return undefined;

    const fileOp: any = { type };
    const filePath = (args.file_path ?? args.path ?? args.relative_path ?? args.filePath ?? args.TargetFile ?? args.target_file) as string | undefined;

    if (filePath) {
      fileOp.path = filePath;
      fileOp.format = extractFormat(filePath);
      fileOp.language = detectLanguage(filePath);
    }

    // Calculate line counts from tool arguments defensively
    if (type === 'write') {
      const content = (args.content ?? args.CodeContent ?? args.body) as string | undefined;
      if (content) {
        const lines = content.split('\n');
        fileOp.linesAdded = lines.length;
      }
    } else if (type === 'edit') {
      const content = (args.content ?? args.CodeContent ?? args.body ?? args.old_string ?? args.needle) as string | undefined;
      const replacement = (args.replacement ?? args.ReplacementContent ?? args.repl ?? args.new_string ?? args.body) as string | undefined;
      
      if (replacement) {
        fileOp.linesAdded = replacement.split('\n').length;
      }
      if (content) {
        fileOp.linesRemoved = content.split('\n').length;
      }

      // Also try to read from result if available (as in existing code)
      if (result) {
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
    }

    return fileOp;
  }
}
