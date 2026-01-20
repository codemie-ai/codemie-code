/**
 * Conversations Processor (Claude-Specific)
 *
 * Transforms Claude session messages into conversation history format.
 *
 * Responsibilities:
 * - Parse Claude messages (user, assistant, tools, agents)
 * - Transform into conversation history format
 * - Write payloads to JSONL with status 'pending'
 * - Extract tool calls, agent thoughts, token usage
 *
 * Note: API sync is handled separately by SSO provider's ConversationSyncProcessor
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import { logger } from '../../../../../utils/logger.js';
import { getSessionConversationPath } from '../../../../core/session/session-config.js';
import { SessionStore } from '../../../../core/session/SessionStore.js';

export class ConversationsProcessor implements SessionProcessor {
  readonly name = 'conversations';
  readonly priority = 2; // Run after metrics (priority 1)

  private sessionStore = new SessionStore();

  /**
   * Get display name for agent
   */
  private getAgentDisplayName(agentName: string): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AgentRegistry } = require('../../../../registry.js');
      const agent = AgentRegistry.getAgent(agentName);
      return agent?.metadata?.displayName || agentName;
    } catch {
      // Fallback to agent name if registry not available
      return agentName;
    }
  }

  shouldProcess(session: ParsedSession): boolean {
    return session.messages && session.messages.length > 0;
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    try {
      // Transform ParsedSession.messages → generate conversation payloads
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
   * Transform ParsedSession.messages to conversation history and write to JSONL
   * Writes payload with status 'pending' for later sync by SSO provider
   * Processes one turn per invocation (incremental mode for real-time hooks)
   */
  private async processMessages(
    session: ParsedSession,
    context: ProcessingContext
  ): Promise<ProcessingResult> {
    try {
      logger.info(`[${this.name}] Transforming ${session.messages.length} messages to conversation history`);

      // Load sync state for incremental processing
      const sessionMetadata = await this.sessionStore.loadSession(session.sessionId);
      if (!sessionMetadata) {
        logger.warn(`[${this.name}] Session metadata not found: ${session.sessionId}`);
        return {
          success: false,
          message: 'Session metadata not found - session must be created before processing'
        };
      }

      const syncState = {
        lastSyncedMessageUuid: sessionMetadata.sync?.conversations?.lastSyncedMessageUuid,
        lastSyncedHistoryIndex: sessionMetadata.sync?.conversations?.lastSyncedHistoryIndex ?? -1
      };

      logger.debug(`[${this.name}] Using sync state:`, {
        lastSyncedMessageUuid: syncState.lastSyncedMessageUuid || 'none',
        lastSyncedHistoryIndex: syncState.lastSyncedHistoryIndex
      });

      const conversationsPath = getSessionConversationPath(session.sessionId);
      const { appendFile, mkdir } = await import('fs/promises');
      const { dirname } = await import('path');
      const { existsSync } = await import('fs');

      const outputDir = dirname(conversationsPath);
      if (!existsSync(outputDir)) {
        await mkdir(outputDir, { recursive: true });
      }

      // Process ONE turn (incremental mode)
      const result = await this.transformMessages(
        session.messages as any[],
        syncState,
        '5a430368-9e91-4564-be20-989803bf4da2',
        session.agentName,
        context.agentSessionFile
      );

      if (result.history.length === 0) {
        logger.debug(`[${this.name}] No history generated from messages`);
        return { success: true, message: 'No history generated', metadata: { recordsProcessed: 0 } };
      }

      // Extract history indices from the result
      const historyIndices = result.history.map((entry: any) => entry.history_index);

      // Create payload record with status 'pending'
      const payloadRecord = {
        timestamp: Date.now(),
        isTurnContinuation: result.isTurnContinuation,
        historyIndices,
        messageCount: result.history.length,
        payload: {
          conversationId: context.agentSessionId,
          history: result.history
        },
        status: 'pending' as const
      };

      await appendFile(conversationsPath, JSON.stringify(payloadRecord) + '\n');

      // Update session sync state
      try {
        const currentSession = await this.sessionStore.loadSession(session.sessionId);
        if (currentSession) {
          currentSession.sync ??= {};
          currentSession.sync.conversations ??= {};
          currentSession.sync.conversations.lastSyncedMessageUuid = result.lastProcessedMessageUuid;
          currentSession.sync.conversations.lastSyncedHistoryIndex = result.currentHistoryIndex;

          await this.sessionStore.saveSession(currentSession);

          logger.debug(`[${this.name}] Updated sync state: lastSyncedMessageUuid=${result.lastProcessedMessageUuid}, lastSyncedHistoryIndex=${result.currentHistoryIndex}`);
        }
      } catch (error) {
        logger.warn(`[${this.name}] Failed to update sync state:`, error);
      }

      logger.info(`[${this.name}] Generated 1 turn with ${result.history.length} conversation messages`);

      return {
        success: true,
        message: 'Generated 1 turn',
        metadata: { recordsProcessed: result.history.length }
      };

    } catch (error) {
      logger.error(`[${this.name}] Failed to process messages:`, error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async transformMessages(
    messages: any[],
    syncState: { lastSyncedMessageUuid?: string; lastSyncedHistoryIndex: number },
    assistantId?: string,
    agentName?: string,
    sessionFilePath?: string
  ): Promise<{ history: any[]; isTurnContinuation: boolean; lastProcessedMessageUuid: string; currentHistoryIndex: number }> {
    let startIndex = 0;
    if (syncState.lastSyncedMessageUuid) {
      const lastSyncedIndex = messages.findIndex(
        (m: any) => m.uuid === syncState.lastSyncedMessageUuid
      );
      if (lastSyncedIndex >= 0) {
        startIndex = lastSyncedIndex + 1;
      }
    }

    const newMessages = messages.slice(startIndex);

    if (newMessages.length === 0) {
      return {
        history: [],
        isTurnContinuation: false,
        lastProcessedMessageUuid: syncState.lastSyncedMessageUuid || '',
        currentHistoryIndex: syncState.lastSyncedHistoryIndex
      };
    }

    let firstRealMessage: any | null = null;

    for (const msg of newMessages) {
      if (!msg.uuid) continue;

      // Skip system messages
      if (msg.type === 'system') continue;

      // Skip non-conversational message types (progress, file-history-snapshot, queue-operation, etc.)
      if (msg.type !== 'user' && msg.type !== 'assistant') continue;

      if (msg.type === 'user' && this.isToolResult(msg)) {
        firstRealMessage = msg;
        break;
      }

      if (this.shouldFilterMessage(msg)) continue;

      firstRealMessage = msg;
      break;
    }

    if (!firstRealMessage) {
      let lastUuid = syncState.lastSyncedMessageUuid || '';
      for (let i = newMessages.length - 1; i >= 0; i--) {
        if (newMessages[i].uuid) {
          lastUuid = newMessages[i].uuid;
          break;
        }
      }

      return {
        history: [],
        isTurnContinuation: false,
        lastProcessedMessageUuid: lastUuid,
        currentHistoryIndex: syncState.lastSyncedHistoryIndex
      };
    }

    const isNewUserMessage = firstRealMessage.type === 'user' &&
                            !this.isToolResult(firstRealMessage);
    const isTurnContinuation = !isNewUserMessage;

    let currentHistoryIndex = syncState.lastSyncedHistoryIndex;
    if (!isTurnContinuation) {
      currentHistoryIndex++;
    }

    let history: any[];
    let lastProcessedMessageUuid = '';

    if (isTurnContinuation) {
      const lastSyncedIndex = syncState.lastSyncedMessageUuid
        ? messages.findIndex((m: any) => m.uuid === syncState.lastSyncedMessageUuid)
        : -1;

      let turnStartIndex = 0;
      if (lastSyncedIndex >= 0) {
        for (let i = lastSyncedIndex; i >= 0; i--) {
          const msg = messages[i];
          if (!msg.uuid) continue;
          if (msg.type === 'user' && !this.shouldFilterMessage(msg) && !this.isToolResult(msg)) {
            turnStartIndex = i;
            break;
          }
        }
      }

      let turnEndIndex = messages.length;
      for (let i = startIndex; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg.uuid) continue;

        // Stop at system messages (e.g., stop hooks)
        if (msg.type === 'system') {
          turnEndIndex = i;
          break;
        }

        if (msg.type === 'user' && !this.shouldFilterMessage(msg) && !this.isToolResult(msg)) {
          turnEndIndex = i;
          break;
        }
      }

      const turnMessages = messages.slice(turnStartIndex, turnEndIndex);

      const turnHistory = await this.transformTurn(
        turnMessages,
        currentHistoryIndex,
        assistantId,
        agentName,
        sessionFilePath
      );

      history = turnHistory.filter((entry: any) => entry.role === 'Assistant');

      for (let i = turnEndIndex - 1; i >= turnStartIndex; i--) {
        if (messages[i].uuid) {
          lastProcessedMessageUuid = messages[i].uuid;
          break;
        }
      }

    } else {
      let firstUserIndex = startIndex;
      for (let i = startIndex; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg.uuid) continue;
        if (msg.type === 'user' && !this.shouldFilterMessage(msg) && !this.isToolResult(msg)) {
          firstUserIndex = i;
          break;
        }
      }

      let turnEndIndex = messages.length;
      for (let i = firstUserIndex + 1; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg.uuid) continue;

        // Stop at system messages (e.g., stop hooks)
        if (msg.type === 'system') {
          turnEndIndex = i;
          break;
        }

        if (msg.type === 'user' && !this.shouldFilterMessage(msg) && !this.isToolResult(msg)) {
          turnEndIndex = i;
          break;
        }
      }

      const turnMessages = messages.slice(firstUserIndex, turnEndIndex);

      history = await this.transformTurn(
        turnMessages,
        currentHistoryIndex,
        assistantId,
        agentName,
        sessionFilePath
      );

      for (let i = turnEndIndex - 1; i >= firstUserIndex; i--) {
        if (messages[i].uuid) {
          lastProcessedMessageUuid = messages[i].uuid;
          break;
        }
      }
    }

    return {
      history,
      isTurnContinuation,
      lastProcessedMessageUuid,
      currentHistoryIndex
    };
  }

  private async transformTurn(
    turnMessages: any[],
    historyIndex: number,
    assistantId?: string,
    agentName?: string,
    sessionFilePath?: string
  ): Promise<any[]> {
    const history: any[] = [];

    const toolResultsMap = this.buildToolResultsMap(turnMessages);

    let userMessage: any | null = null;
    for (const msg of turnMessages) {
      if (msg.type === 'user' && !this.shouldFilterMessage(msg) && !this.isToolResult(msg)) {
        userMessage = msg;
        break;
      }
    }

    if (!userMessage) {
      return [];
    }

    const userText = this.extractUserMessage(userMessage);
    history.push({
      role: 'User',
      message: userText,
      history_index: historyIndex,
      date: userMessage.timestamp,
      message_raw: userText,
      file_names: []
    });

    const assistantMessages: any[] = [];
    const metaMessages: any[] = [];
    const systemErrors: any[] = [];

    for (const msg of turnMessages) {
      if (msg.type === 'assistant') {
        assistantMessages.push(msg);
      } else if (msg.type === 'user' && (msg as any).isMeta) {
        metaMessages.push(msg);
      } else if (msg.type === 'system' && msg.subtype === 'api_error') {
        systemErrors.push(msg);
      }
    }

    if (assistantMessages.length > 0) {
      const finalAssistantMsg = assistantMessages[assistantMessages.length - 1];

      const allThoughts: any[] = [];

      for (const metaMsg of metaMessages) {
        const metaText = this.extractTextContent(metaMsg);
        if (metaText.trim()) {
          allThoughts.push(this.createCodemieThought(
            metaMsg.uuid,
            metaText,
            agentName || 'Claude Code',
            metaMsg.timestamp
          ));
        }
      }

      for (let k = 0; k < assistantMessages.length; k++) {
        const assistantMsg = assistantMessages[k];
        const isIntermediateMsg = k < assistantMessages.length - 1;

        const hasError = assistantMsg.message?.Output?.__type || assistantMsg.message?.error;
        if (hasError) {
          const errorType = assistantMsg.message?.Output?.__type || 'Error';
          const errorMsg = assistantMsg.message?.error?.message || errorType;
          allThoughts.push({
            id: assistantMsg.uuid,
            metadata: {
              timestamp: assistantMsg.timestamp,
              error_type: errorType
            },
            in_progress: false,
            author_type: 'Agent',
            author_name: this.getAgentDisplayName(agentName || assistantMsg.message?.model || 'claude'),
            message: `Error: ${errorMsg}`,
            input_text: '',
            output_format: 'error',
            error: true,
            children: []
          });
          continue;
        }

        const toolCalls = this.extractToolCalls(assistantMsg);
        for (const toolCall of toolCalls) {
          const toolResult = toolResultsMap.get(toolCall.id);

          const shouldAddTool = toolResult !== undefined || isIntermediateMsg;

          if (shouldAddTool) {
            allThoughts.push(this.createToolThought(toolCall, toolResult));

            if (toolResult?.agentId && sessionFilePath) {
              try {
                const subagentType = toolCall.name === 'Task' && toolCall.input?.subagent_type
                  ? String(toolCall.input.subagent_type)
                  : undefined;

                const agentFile = await this.findAgentFileByAgentId(sessionFilePath, toolResult.agentId);

                if (agentFile) {
                  const parsed = await this.parseAgentFile(agentFile, subagentType);

                  if (parsed) {
                    const agentThought = this.createAgentThought(parsed);
                    allThoughts.push(agentThought);

                    logger.debug(
                      `[${this.name}] Added Agent thought for ${toolResult.slug || toolResult.agentId}: ` +
                      `${parsed.toolChildren.length} tools, ${parsed.agentMessage.length} chars`
                    );
                  }
                }
              } catch (error) {
                logger.error(`[${this.name}] Failed to process agent file for ${toolResult.agentId}:`, error);
              }
            }
          }
        }

        if (isIntermediateMsg) {
          const intermediateText = this.extractTextContent(assistantMsg);
          if (intermediateText.trim()) {
            allThoughts.push(this.createCodemieThought(
              assistantMsg.uuid,
              intermediateText,
              agentName || assistantMsg.message?.model || 'claude',
              assistantMsg.timestamp
            ));
          }
        }
      }

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheCreationTokens = 0;
      let totalCacheReadTokens = 0;

      for (const assistantMsg of assistantMessages) {
        const usage = assistantMsg.message?.usage;
        if (usage) {
          totalInputTokens += usage.input_tokens || 0;
          totalOutputTokens += usage.output_tokens || 0;
          totalCacheCreationTokens += usage.cache_creation_input_tokens || 0;
          totalCacheReadTokens += usage.cache_read_input_tokens || 0;
        }
      }

      for (const thought of allThoughts) {
        if (thought.author_type === 'Agent' && thought.metadata?.token_usage) {
          const agentTokens = thought.metadata.token_usage as any;
          totalInputTokens += agentTokens.input || 0;
          totalOutputTokens += agentTokens.output || 0;
          totalCacheCreationTokens += agentTokens.cacheCreation || 0;
          totalCacheReadTokens += agentTokens.cacheRead || 0;
        }
      }

      const assistantText = this.extractTextContent(finalAssistantMsg);
      const finalHasError = finalAssistantMsg.message?.Output?.__type ||
                           finalAssistantMsg.message?.error;
      let errorMessage = finalHasError
        ? `Error: ${finalAssistantMsg.message?.Output?.__type ||
                    finalAssistantMsg.message?.error?.message || 'Unknown error'}`
        : assistantText;

      if (!errorMessage.trim() && allThoughts.length === 0) {
        return history;
      }

      const response_time = this.calculateDuration(userMessage.timestamp, finalAssistantMsg.timestamp);

      history.push({
        role: 'Assistant',
        message: errorMessage,
        message_raw: finalHasError ? errorMessage : (assistantText || errorMessage),
        history_index: historyIndex,
        date: finalAssistantMsg.timestamp,
        response_time,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cache_creation_input_tokens: totalCacheCreationTokens,
        cache_read_input_tokens: totalCacheReadTokens,
        assistant_id: assistantId,
        thoughts: allThoughts.length > 0 ? allThoughts : undefined
      });

    } else if (systemErrors.length > 0) {
      const errorThoughts: any[] = systemErrors.map((error: any) => {
        const errorMsg = error.error?.error?.Message ||
                        error.error?.error?.message || 'Unknown error';
        const errorStatus = error.error?.status || 'unknown';
        return {
          id: error.uuid,
          metadata: {
            timestamp: error.timestamp,
            error_status: errorStatus
          },
          in_progress: false,
          author_type: 'Agent',
          author_name: this.getAgentDisplayName(agentName || 'claude'),
          message: `API Error (${errorStatus}): ${errorMsg}`,
          input_text: '',
          output_format: 'error',
          error: true,
          children: []
        };
      });

      const lastError = systemErrors[systemErrors.length - 1];
      const response_time = this.calculateDuration(userMessage.timestamp, lastError.timestamp);

      history.push({
        role: 'Assistant',
        message: `Failed after ${systemErrors.length} error(s): ${errorThoughts[0].message}`,
        message_raw: `Failed after ${systemErrors.length} error(s)`,
        history_index: historyIndex,
        date: lastError.timestamp,
        response_time,
        assistant_id: assistantId,
        thoughts: errorThoughts
      });
    }

    return history;
  }

  private shouldFilterMessage(msg: any): boolean {
    // Filter system messages (including stop hooks)
    if (msg.type === 'system') return true;

    return this.isConversationSplitter(msg) ||
           this.isSystemMessage(msg) ||
           this.isToolResult(msg);
  }

  private isConversationSplitter(msg: any): boolean {
    return this.hasCommand(msg, ['/clear']);
  }

  private isSystemMessage(msg: any): boolean {
    if (msg.type !== 'user') return false;

    if (this.hasCommand(msg, ['/compact', '/compress'])) {
      return true;
    }

    const text = this.extractTextContent(msg);
    if (!text) return false;

    const patterns = [
      'Caveat: The messages below were generated by the user while running local commands',
      '<local-command-caveat>',
      'Unknown slash command:',
      '<local-command-stdout>',
      '[Request interrupted by user'
    ];

    return patterns.some(pattern => text.startsWith(pattern));
  }

  private isToolResult(msg: any): boolean {
    if (msg.type !== 'user') return false;
    const content = msg.message?.content;
    if (!Array.isArray(content)) return false;

    const hasToolResult = content.some((item: any) => item.type === 'tool_result');
    if (!hasToolResult) return false;

    const hasText = content.some((item: any) =>
      item.type === 'text' && item.text?.trim()
    );

    return hasToolResult && !hasText;
  }

  private hasCommand(msg: any, commands: string[]): boolean {
    if (msg.type !== 'user') return false;

    const content = msg.message?.content;

    if (typeof content === 'string') {
      return commands.some(cmd =>
        content.includes(`<command-name>${cmd}</command-name>`)
      );
    }

    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === 'text' && item.text) {
          if (commands.some(cmd =>
            item.text?.includes(`<command-name>${cmd}</command-name>`)
          )) {
            return true;
          }
        }
      }
    }

    return false;
  }

  private buildToolResultsMap(messages: any[]): Map<string, any> {
    const map = new Map<string, any>();

    for (const msg of messages) {
      if (this.isToolResult(msg)) {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'tool_result') {
              const isError = (item as any).is_error === true || item.isError === true;

              let textContent = '';
              if (typeof item.content === 'string') {
                textContent = item.content;
              } else if (Array.isArray(item.content)) {
                textContent = item.content
                  .filter((c: any) => c.type === 'text')
                  .map((c: any) => c.text || '')
                  .join('\n\n');
              }

              const agentId = msg.toolUseResult?.agentId;
              const slug = msg.toolUseResult?.slug;

              map.set(item.tool_use_id || '', {
                content: textContent,
                isError,
                agentId,
                slug
              });
            }
          }
        }
      }
    }

    return map;
  }

  private extractUserMessage(msg: any): string {
    const content = msg.message?.content;

    if (typeof content === 'string') {
      const command = this.extractCommand(content);
      if (command) {
        return command;
      }
      return content;
    }

    if (Array.isArray(content)) {
      const textParts = content
        .filter((item: any) => item.type === 'text')
        .map((item: any) => {
          const text = item.text || '';
          const command = this.extractCommand(text);
          if (command) {
            return command;
          }
          return text;
        });
      return textParts.join('\n\n');
    }

    return '';
  }

  private extractTextContent(msg: any): string {
    const content = msg.message?.content;

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const textParts = content
        .filter((item: any) => item.type === 'text' || item.type === 'thinking')
        .map((item: any) => {
          if (item.type === 'thinking') {
            return item.thinking || '';
          }
          return item.text || '';
        });
      return textParts.join('\n\n');
    }

    return '';
  }

  private extractCommand(content: string): string | null {
    const commandMatch = content.match(/<command-name>(\/[^<]+)<\/command-name>/);
    return commandMatch ? commandMatch[1] : null;
  }

  private extractToolCalls(msg: any): any[] {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];

    return content.filter((item: any) => item.type === 'tool_use');
  }

  private createToolThought(toolCall: any, toolResult?: any): any {
    return {
      id: toolCall.id,
      metadata: {},
      in_progress: false,
      input_text: JSON.stringify(toolCall.input),
      message: toolResult?.content || '',
      author_type: 'Tool',
      author_name: toolCall.name,
      output_format: 'text',
      error: toolResult?.isError || false,
      children: []
    };
  }

  private createCodemieThought(
    id: string,
    message: string,
    agentName: string,
    timestamp: string
  ): any {
    // Get display name from agent metadata
    const displayName = this.getAgentDisplayName(agentName);

    return {
      id,
      metadata: {
        timestamp,
        type: 'intermediate_response'
      },
      in_progress: false,
      input_text: '',
      message,
      author_type: 'Agent',
      author_name: displayName,
      output_format: 'text',
      error: false,
      children: []
    };
  }

  private async findAgentFileByAgentId(
    sessionFilePath: string,
    agentId: string
  ): Promise<string | null> {
    try {
      const { dirname, basename, join } = await import('path');
      const { existsSync } = await import('fs');

      const parentDir = dirname(sessionFilePath);
      const filename = basename(sessionFilePath);
      const sessionId = filename.replace('.jsonl', '');

      if (!sessionId) {
        return null;
      }

      const subagentsDir = join(parentDir, sessionId, 'subagents');

      if (!existsSync(subagentsDir)) {
        return null;
      }

      const agentFilePath = join(subagentsDir, `agent-${agentId}.jsonl`);

      if (existsSync(agentFilePath)) {
        logger.debug(`[${this.name}] Found agent file for ${agentId}: ${agentFilePath}`);
        return agentFilePath;
      }

      logger.debug(`[${this.name}] Agent file not found for ${agentId} in ${subagentsDir}`);
      return null;
    } catch (error) {
      logger.debug(`[${this.name}] Failed to find agent file by agentId:`, error);
      return null;
    }
  }

  private async parseAgentFile(
    agentFilePath: string,
    subagentType?: string
  ): Promise<any | null> {
    try {
      const { readFile } = await import('fs/promises');
      const { existsSync } = await import('fs');

      if (!existsSync(agentFilePath)) {
        return null;
      }

      const content = await readFile(agentFilePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);

      const records: any[] = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
        } catch (error) {
          logger.warn(`[${this.name}] Failed to parse line in ${agentFilePath}:`, error);
        }
      }

      if (records.length === 0) {
        logger.debug(`[${this.name}] Empty agent file: ${agentFilePath}`);
        return null;
      }

      const firstRecord = records[0];
      if (!firstRecord.isSidechain) {
        logger.warn(`[${this.name}] File is not a sidechain: ${agentFilePath}`);
        return null;
      }

      const agentId = firstRecord.agentId;
      const sessionId = firstRecord.sessionId;

      const slug = records.find((r: any) => r.slug)?.slug || 'Agent';

      let agentMessage = '';
      const toolChildren: any[] = [];
      const tokenUsage = {
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0
      };

      for (const record of records) {
        if (record.sessionId !== sessionId) {
          logger.warn(
            `[${this.name}] Session ID mismatch in ${agentFilePath}: ` +
            `expected ${sessionId}, got ${record.sessionId}`
          );
          continue;
        }

        // Skip records without message (e.g., progress records)
        if (!record.message) {
          continue;
        }

        const content = record.message.content;

        if (typeof content === 'string') {
          agentMessage += content + '\n\n';
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'text') {
              agentMessage += (item.text || '') + '\n\n';
            } else if (item.type === 'thinking') {
              agentMessage += (item.thinking || '') + '\n\n';
            } else if (item.type === 'tool_use') {
              toolChildren.push({
                id: item.id || `tool-${record.uuid}`,
                parent_id: 'latest',
                metadata: {
                  timestamp: record.timestamp
                },
                in_progress: false,
                input_text: JSON.stringify(item.input || {}),
                message: '',
                author_type: 'Tool',
                author_name: item.name || 'Unknown',
                output_format: 'text',
                error: false,
                children: []
              });
            }
          }
        }

        const usage = record.message.usage;
        if (usage) {
          tokenUsage.input += usage.input_tokens || 0;
          tokenUsage.output += usage.output_tokens || 0;
          tokenUsage.cacheCreation += usage.cache_creation_input_tokens || 0;
          tokenUsage.cacheRead += usage.cache_read_input_tokens || 0;
        }
      }

      for (const record of records) {
        if (record.sessionId !== sessionId) {
          continue;
        }

        // Skip records without message (e.g., progress records)
        if (!record.message) {
          continue;
        }

        const content = record.message.content;

        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'tool_result') {
              const toolThought = toolChildren.find((t: any) => t.id === item.tool_use_id);
              if (toolThought) {
                if (typeof item.content === 'string') {
                  toolThought.message = item.content;
                } else if (Array.isArray(item.content)) {
                  toolThought.message = item.content
                    .map((c: any) => c.type === 'text' ? c.text : '')
                    .filter((t: string) => t.length > 0)
                    .join('\n\n');
                }

                if (item.is_error || item.isError) {
                  toolThought.error = true;
                }
              }
            }
          }
        }
      }

      return {
        agentId,
        slug,
        subagentType,
        agentMessage: agentMessage.trim(),
        toolChildren,
        tokenUsage,
        startTimestamp: records[0].timestamp,
        endTimestamp: records[records.length - 1].timestamp
      };

    } catch (error) {
      logger.error(`[${this.name}] Failed to parse agent file ${agentFilePath}:`, error);
      return null;
    }
  }

  private createAgentThought(parsed: any): any {
    return {
      id: `agent-${parsed.agentId}`,
      metadata: {
        agent_id: parsed.agentId,
        slug: parsed.slug,
        subagent_type: parsed.subagentType,
        start_timestamp: parsed.startTimestamp,
        end_timestamp: parsed.endTimestamp,
        token_usage: parsed.tokenUsage
      },
      in_progress: false,
      input_text: '',
      message: parsed.agentMessage,
      author_type: 'Agent',
      author_name: parsed.subagentType || parsed.slug,
      output_format: 'text',
      error: false,
      children: parsed.toolChildren
    };
  }

  private calculateDuration(startTimestamp: string, endTimestamp: string): number | undefined {
    try {
      const startMs = new Date(startTimestamp).getTime();
      const endMs = new Date(endTimestamp).getTime();

      if (isNaN(startMs) || isNaN(endMs)) {
        return undefined;
      }

      const durationMs = endMs - startMs;

      if (durationMs < 0) {
        logger.warn('[conversations] Negative duration detected (clock skew?):', { startTimestamp, endTimestamp });
        return 0;
      }

      const durationSec = durationMs / 1000;
      return Math.round(durationSec * 100) / 100;
    } catch (error) {
      logger.error('[conversations] Error calculating duration:', error);
      return undefined;
    }
  }
}
