/**
 * Metrics Processor (Claude-Specific)
 *
 * Transforms Claude session messages into metric deltas.
 *
 * Responsibilities:
 * - Parse Claude messages (user, assistant, tools)
 * - Extract token usage, tool calls, file operations
 * - Write deltas to JSONL with status 'pending'
 *
 * Note: API sync is handled separately by SSO provider's MetricsSyncProcessor
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import { logger } from '../../../../../utils/logger.js';
import type { MetricDelta } from '../../../../core/metrics/types.js';
import { extractFormat, detectLanguage } from '../../../../../utils/file-operations.js';

export class MetricsProcessor implements SessionProcessor {
  readonly name = 'metrics';
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
   * Transform messages to deltas
   */
  private transformMessagesToDeltas(session: ParsedSession): Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> {
    const deltas: Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> = [];
    const processedIds = new Set<string>();
    const attachedUserPrompts = new Set<string>();

    const mainDeltas = this.extractDeltasFromMessages(
      session.messages as any[],
      session.sessionId,
      session.agentName,
      processedIds,
      attachedUserPrompts
    );
    deltas.push(...mainDeltas);

    if (session.subagents) {
      for (const subagent of session.subagents) {
        const subDeltas = this.extractDeltasFromMessages(
          subagent.messages as any[],
          session.sessionId,
          session.agentName,
          processedIds,
          attachedUserPrompts
        );
        deltas.push(...subDeltas);
      }
    }

    return deltas;
  }

  /**
   * Extract deltas from Claude messages
   */
  private extractDeltasFromMessages(
    messages: any[],
    sessionId: string,
    agentName: string,
    processedIds: Set<string>,
    attachedUserPrompts: Set<string>
  ): Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> {
    const deltas: Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> = [];

    // Build tool results map with full content
    const toolResultsMap = new Map<string, { isError: boolean; content: any }>();
    for (const msg of messages) {
      if (msg.message?.content && Array.isArray(msg.message.content)) {
        for (const item of msg.message.content) {
          if (item.type === 'tool_result' && item.tool_use_id) {
            toolResultsMap.set(item.tool_use_id, {
              isError: item.is_error === true,
              content: item.content || item
            });
          }
        }
      }
    }

    // Build tool use result map (tool_use_id → toolUseResult from USER message)
    const toolUseResultMap = new Map<string, any>();
    for (const msg of messages) {
      if (msg.type === 'user' && msg.toolUseResult) {
        // Find the tool_result content item to get tool_use_id
        if (msg.message?.content && Array.isArray(msg.message.content)) {
          for (const item of msg.message.content) {
            if (item.type === 'tool_result' && item.tool_use_id) {
              toolUseResultMap.set(item.tool_use_id, msg.toolUseResult);
            }
          }
        }
      }
    }

    // Build user prompts map: uuid → text content
    const userPromptsMap = new Map<string, string>();
    for (const msg of messages) {
      if (msg.message?.role === 'user' && msg.uuid) {
        let textContent = '';

        if (Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              textContent = block.text;
              break;
            }
          }
        } else if (typeof msg.message.content === 'string') {
          textContent = msg.message.content;
        }

        if (textContent) {
          userPromptsMap.set(msg.uuid, textContent);
        }
      }
    }

    // Extract deltas from assistant messages
    for (const msg of messages) {
      if (!msg.uuid || processedIds.has(msg.uuid)) {
        continue;
      }

      if (msg.message?.role !== 'assistant' || !msg.message?.usage) {
        continue;
      }

      let hasUnresolvedTools = false;
      if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use' && !toolResultsMap.has(block.id)) {
            hasUnresolvedTools = true;
            break;
          }
        }
      }

      if (hasUnresolvedTools) {
        continue;
      }

      const usage = msg.message.usage;
      const tokens = {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        cacheCreation: usage.cache_creation_input_tokens || undefined,
        cacheRead: usage.cache_read_input_tokens || undefined
      };

      const tools: Record<string, number> = {};
      const toolStatus: Record<string, { success: number; failure: number }> = {};
      const fileOperations: Array<{ type: string; path?: string; linesAdded?: number; linesRemoved?: number }> = [];

      if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use' && toolResultsMap.has(block.id)) {
            const toolName = block.name;
            tools[toolName] = (tools[toolName] || 0) + 1;

            if (!toolStatus[toolName]) {
              toolStatus[toolName] = { success: 0, failure: 0 };
            }

            const toolResult = toolResultsMap.get(block.id)!;
            if (toolResult.isError) {
              toolStatus[toolName].failure++;
            } else {
              toolStatus[toolName].success++;

              // Extract file operations for successful tool calls
              const toolUseResult = toolUseResultMap.get(block.id);
              const fileOp = this.extractFileOperation(toolName, block.input, toolUseResult);
              if (fileOp) {
                fileOperations.push(fileOp);
              }
            }
          }
        }
      }

      const delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'> = {
        recordId: msg.uuid,
        sessionId,
        agentSessionId: msg.sessionId || '',
        timestamp: msg.timestamp || new Date().toISOString(),
        gitBranch: msg.gitBranch,
        tokens,
        ...(Object.keys(tools).length > 0 && { tools }),
        ...(Object.keys(toolStatus).length > 0 && { toolStatus }),
        ...(msg.message?.model && { models: [msg.message.model] })
      };

      // Attach file operations if any for THIS delta
      if (fileOperations.length > 0) {
        (delta as any).fileOperations = fileOperations;
      }

      // Attach user prompts to FIRST delta GLOBALLY (across all calls)
      // Check if we haven't attached any userPrompts yet
      if (deltas.length === 0 && attachedUserPrompts.size === 0 && userPromptsMap.size > 0) {
        const prompts: Array<{ count: number; text: string }> = [];

        for (const [uuid, text] of userPromptsMap.entries()) {
          prompts.push({ count: 1, text });
          attachedUserPrompts.add(uuid);
        }

        if (prompts.length > 0) {
          (delta as any).userPrompts = prompts;
        }
      }

      deltas.push(delta);
      processedIds.add(msg.uuid);
    }

    return deltas;
  }

  /**
   * Extract file operation from tool call (simplified version of legacy logic)
   */
  private extractFileOperation(
    toolName: string,
    input: any,
    toolUseResult?: any
  ): { type: string; path?: string; format?: string; language?: string; pattern?: string; linesAdded?: number; linesRemoved?: number } | undefined {
    const typeMap: Record<string, string> = {
      'Read': 'read',
      'Write': 'write',
      'Edit': 'edit',
      'Grep': 'grep',
      'Glob': 'glob'
    };

    const type = typeMap[toolName];
    if (!type) return undefined;

    const fileOp: any = { type };

    const filePath = toolUseResult?.filePath || toolUseResult?.file?.filePath || input?.file_path || input?.path;

    if (filePath) {
      fileOp.path = filePath;
      fileOp.format = extractFormat(filePath);
      fileOp.language = detectLanguage(filePath);
    } else if (input?.pattern) {
      fileOp.pattern = input.pattern;
    }

    if (toolName === 'Write') {
      const content = toolUseResult?.content || toolUseResult?.file?.content || input?.content;
      if (content) {
        const lines = content.split('\n');
        fileOp.linesAdded = lines.length;
      }
    } else if (toolName === 'Edit' && toolUseResult?.structuredPatch) {
      let added = 0;
      let removed = 0;

      for (const patch of toolUseResult.structuredPatch) {
        if (Array.isArray(patch.lines)) {
          for (const line of patch.lines) {
            if (typeof line === 'string') {
              if (line.startsWith('+')) added++;
              else if (line.startsWith('-')) removed++;
            }
          }
        }
      }

      if (added > 0) fileOp.linesAdded = added;
      if (removed > 0) fileOp.linesRemoved = removed;
    }

    return fileOp;
  }
}
