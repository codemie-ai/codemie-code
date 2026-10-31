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
import { extractClaudeFileOperation } from '../claude-file-operation.js';
import { stripClear } from '../strip-clear.js';
import { takeMessagesBefore } from './messages-before.js';
import type { ClaudeMessage } from '../../claude-message-types.js';
import { resolveRunWindow } from '../../../../core/session/run-window.js';
import { collectRunPromptsAndInvocations, PROMPTS_RECORD_SUFFIX } from './run-prompts.js';

interface RunOptions {
  /** Lines stamped before it give the run no prompt or named invocation. */
  cutoffMs?: number;
  /** The SessionEnd pass: the trailing lines with no emitted group are counted too. */
  finalPass?: boolean;
  /** A subagent file: its trailing lines on the final pass give named invocations only, no prompt. */
  namedOnly?: boolean;
}

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
    context: ProcessingContext
  ): Promise<ProcessingResult> {
    try {
      // Load session state to get previously processed record IDs
      const { SessionStore } = await import('../../../../core/session/SessionStore.js');
      const sessionStore = new SessionStore();
      const sessionMetadata = await sessionStore.loadSession(session.sessionId);

      if (!sessionMetadata) {
        logger.warn(`[${this.name}] Session metadata not found: ${session.sessionId}`);
        return {
          success: false,
          message: 'Session metadata not found - session must be created before processing'
        };
      }

      // Load existing processed record IDs
      const existingProcessedIds = new Set<string>(
        sessionMetadata.sync?.metrics?.processedRecordIds || []
      );

      logger.debug(`[${this.name}] Loaded ${existingProcessedIds.size} previously processed record IDs`);

      logger.info(`[${this.name}] Transforming ${session.messages.length} messages to deltas`);

      // Pass existing processed IDs instead of creating empty Set
      const deltas = this.transformMessagesToDeltas(session, existingProcessedIds, {
        cutoffMs: sessionMetadata.sync?.metrics?.baselineCutoffMs,
        finalPass: context.finalPass === true
      });

      if (deltas.length === 0) {
        logger.debug(`[${this.name}] No deltas generated from messages`);
        return { success: true, message: 'No deltas generated', metadata: { recordsProcessed: 0 } };
      }

      const { MetricsWriter } = await import('../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
      const writer = new MetricsWriter(session.sessionId);

      await writer.appendDeltas(deltas, await resolveRunWindow(session.sessionId, context));

      logger.info(`[${this.name}] Generated and wrote ${deltas.length} deltas`);

      // Return sync updates for the adapter to persist
      return {
        success: true,
        message: `Generated ${deltas.length} deltas`,
        metadata: {
          recordsProcessed: deltas.length,
          syncUpdates: deltas.length > 0 ? {
            metrics: {
              processedRecordIds: Array.from(existingProcessedIds),
              lastProcessedTimestamp: Date.now(),
              totalDeltas: deltas.length
            }
          } : undefined
        }
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
   * Record ids the delta extraction would mark as processed for transcript content written
   * before `cutoffMs` (main and subagent messages). Nothing is written, so storing these ids
   * keeps that content from ever being emitted as deltas.
   */
  computeBaselineRecordIds(session: ParsedSession, existingIds: Iterable<string>, cutoffMs: number): string[] {
    const processedIds = new Set<string>(existingIds);
    const priorSession: ParsedSession = {
      ...session,
      messages: takeMessagesBefore(session.messages as ClaudeMessage[], cutoffMs),
      ...(session.subagents && {
        subagents: session.subagents.map(subagent => ({
          ...subagent,
          messages: takeMessagesBefore(subagent.messages as ClaudeMessage[], cutoffMs)
        }))
      })
    };
    this.transformMessagesToDeltas(priorSession, processedIds);
    return Array.from(processedIds);
  }

  /**
   * Transform messages to deltas
   */
  private transformMessagesToDeltas(
    session: ParsedSession,
    existingProcessedIds: Set<string>,
    options: RunOptions = {}
  ): Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> {
    const deltas: Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> = [];
    const processedIds = existingProcessedIds;
    const attachedUserPrompts = new Set<string>();

    const mainDeltas = this.extractDeltasFromMessages(
      session.messages as any[],
      session.sessionId,
      session.agentName,
      processedIds,
      attachedUserPrompts,
      options
    );
    deltas.push(...mainDeltas);

    if (session.subagents) {
      for (const subagent of session.subagents) {
        const subDeltas = this.extractDeltasFromMessages(
          subagent.messages as any[],
          session.sessionId,
          session.agentName,
          processedIds,
          attachedUserPrompts,
          { cutoffMs: options.cutoffMs, finalPass: options.finalPass, namedOnly: true }
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
    rawMessages: any[],
    sessionId: string,
    agentName: string,
    processedIds: Set<string>,
    attachedUserPrompts: Set<string>,
    { cutoffMs, finalPass = false, namedOnly = false }: RunOptions = {}
  ): Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> {
    const messages = stripClear(rawMessages) as any[];

    const deltas: Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> = [];
    const messagesByUuid = new Map<string, any>();

    for (const msg of messages) {
      if (msg.uuid) {
        messagesByUuid.set(msg.uuid, msg);
      }
    }

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

    let lastProcessedMsgIndex = -1;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (
        (msg.message?.role === 'assistant' && msg.message?.id && processedIds.has(msg.message.id)) ||
        (msg.uuid && processedIds.has(`${msg.uuid}${PROMPTS_RECORD_SUFFIX}`))
      ) {
        lastProcessedMsgIndex = i;
      }
    }

    // Group messages by message.id to handle streaming chunks
    // Claude streaming creates multiple JSONL entries (thinking, text, tool_use)
    // for the same API response, each with the same message.id and usage
    const messageGroups = new Map<string, any[]>();
    const groupLastIndex = new Map<string, number>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.message?.role === 'assistant' && msg.message?.id) {
        const messageId = msg.message.id;
        if (!messageGroups.has(messageId)) {
          messageGroups.set(messageId, []);
        }
        messageGroups.get(messageId)!.push(msg);
        groupLastIndex.set(messageId, i);
      }
    }
    let lastEmittedIndex = -1;

    // Helper function to process a message or group of messages into a delta
    const processDelta = (messages: any[], trackingId: string) => {
      // Skip if already processed
      if (processedIds.has(trackingId)) {
        return;
      }

      // Find completed message (one that has usage object — skips incomplete streaming chunks)
      const completedMsg = messages.find(m => m.message?.usage);
      if (!completedMsg) {
        return;
      }

      // Check for unresolved tools across all messages
      let hasUnresolvedTools = false;
      for (const msg of messages) {
        if (Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use' && !toolResultsMap.has(block.id)) {
              hasUnresolvedTools = true;
              break;
            }
          }
        }
        if (hasUnresolvedTools) break;
      }

      if (hasUnresolvedTools) {
        return;
      }

      // Aggregate tools and file operations
      const tools: Record<string, number> = {};
      const toolStatus: Record<string, { success: number; failure: number }> = {};
      const fileOperations: Array<{ type: string; path?: string; linesAdded?: number; linesRemoved?: number }> = [];

      for (const msg of messages) {
        if (Array.isArray(msg.message?.content)) {
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

                // Extract file operations
                const toolUseResult = toolUseResultMap.get(block.id);
                const fileOp = extractClaudeFileOperation(toolName, block.input, toolUseResult);
                if (fileOp) {
                  fileOperations.push(fileOp);
                }
              }
            }
          }
        }
      }

      const recordId = messages[0].uuid;

      const apiErrorMessage = completedMsg.isApiErrorMessage && completedMsg.message?.content?.[0]?.text
        ? completedMsg.message.content[0].text
        : undefined;

      const delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'> = {
        recordId,
        sessionId,
        agentSessionId: completedMsg.sessionId || '',
        timestamp: completedMsg.timestamp || new Date().toISOString(),
        gitBranch: completedMsg.gitBranch,
        ...(Object.keys(tools).length > 0 && { tools }),
        ...(Object.keys(toolStatus).length > 0 && { toolStatus }),
        ...(completedMsg.message?.model && { models: [completedMsg.message.model] }),
        ...(apiErrorMessage && { apiErrorMessage })
      };

      if (fileOperations.length > 0) {
        (delta as any).fileOperations = fileOperations;
      }

      deltas.push(delta);
      processedIds.add(trackingId);
      lastEmittedIndex = Math.max(lastEmittedIndex, groupLastIndex.get(trackingId)!);
    };

    // Process grouped messages (streaming chunks with same message.id)
    for (const [messageId, groupedMessages] of messageGroups.entries()) {
      processDelta(groupedMessages, messageId);
    }

    if (deltas.length === 0 && !finalPass) {
      return deltas;
    }

    const { prompts, named, promptsDelta } = collectRunPromptsAndInvocations(messages, messagesByUuid, {
      sessionId, processedIds, attachedUserPrompts, lastProcessedMsgIndex, lastEmittedIndex,
      emittedDeltas: deltas.length > 0, cutoffMs, finalPass, namedOnly
    });
    if (promptsDelta) deltas.push(promptsDelta);

    if (deltas.length === 0) {
      return deltas;
    }

    const first = deltas[0];
    if (Object.keys(named.skillInvocations).length > 0) first.skillInvocations = named.skillInvocations;
    if (Object.keys(named.agentInvocations).length > 0) first.agentInvocations = named.agentInvocations;
    if (Object.keys(named.commandInvocations).length > 0) first.commandInvocations = named.commandInvocations;
    if (prompts.length > 0) {
      first.userPrompts = prompts;
    }

    return deltas;
  }
}
