/**
 * Claude Code Analytics Adapter
 *
 * Extracts analytics data from Claude Code session files stored in:
 * ~/.claude/projects/{projectPath}/{sessionId}.jsonl
 *
 * JSONL Format: One JSON event per line
 * - type: "user" | "assistant" | "file-history-snapshot"
 * - Linked via parentUuid chain
 * - Tool calls embedded in message.content array
 */

import { join, extname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import {
  BaseAnalyticsAdapter,
  AdapterMetadata,
  resolvePath,
  findFiles,
  filterFilesByDate,
  readJSONL,
  detectLanguage,
  detectFormat,
  countLines,
  calculateByteSize,
  calculateFileStats
} from '../core/index.js';
import {
  SessionQueryOptions,
  SessionDescriptor,
  CodemieSession,
  CodemieMessage,
  CodemieToolCall,
  CodemieFileModification
} from '../types.js';

/**
 * Claude JSONL event types
 */
interface ClaudeEvent {
  type: string;
  sessionId: string;
  uuid: string;
  timestamp: string;
  parentUuid?: string | null;
  message?: ClaudeMessage;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  toolUseResult?: Record<string, unknown>;
  snapshot?: ClaudeSnapshot;
}

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: ClaudeContent[] | string;
  model?: string;
  usage?: ClaudeUsage;
}

interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

type ClaudeContent = ClaudeTextContent | ClaudeToolUseContent | ClaudeToolResultContent;

interface ClaudeTextContent {
  type: 'text';
  text: string;
}

interface ClaudeToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ClaudeToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | unknown[];
  is_error?: boolean;
}

interface ClaudeSnapshot {
  messageId: string;
  trackedFileBackups: Record<string, unknown>;
  timestamp: string;
}

/**
 * Claude Code analytics adapter
 */
export class ClaudeAnalyticsAdapter extends BaseAnalyticsAdapter {
  constructor(metadata: AdapterMetadata) {
    super(metadata);
  }

  async findSessions(options?: SessionQueryOptions): Promise<SessionDescriptor[]> {
    const baseDir = resolvePath(this.homePath);
    const projectsDir = join(baseDir, 'projects');

    if (!existsSync(projectsDir)) {
      return [];
    }

    const descriptors: SessionDescriptor[] = [];
    const sessionMap = new Map<string, { files: string[]; metadata: Record<string, unknown> }>();

    // Scan all project directories
    const { readdir } = await import('node:fs/promises');
    try {
      const projectDirs = await readdir(projectsDir, { withFileTypes: true });

      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) continue;

        const projectPath = join(projectsDir, projectDir.name);

        // Find all JSONL files (main sessions and agent sessions)
        const jsonlFiles = await findFiles(projectPath, /\.jsonl$/);

        // Filter by date if specified
        let filteredFiles = jsonlFiles;
        if (options?.dateFrom || options?.dateTo) {
          filteredFiles = await filterFilesByDate(jsonlFiles, options.dateFrom, options.dateTo);
        }

        // Group files by sessionId
        for (const filePath of filteredFiles) {
          try {
            // Read first few lines to find sessionId (first line might be snapshot without sessionId)
            const events = await readJSONL(filePath, 10);
            if (events.length === 0) continue;

            // Find first event with sessionId (has cwd and other metadata)
            const eventWithSession = events.find((e: ClaudeEvent) => e.sessionId) as ClaudeEvent | undefined;
            if (!eventWithSession) continue;

            const sessionId = eventWithSession.sessionId;

            // Check if this is the main session file (named with sessionId)
            const fileName = basename(filePath, '.jsonl');
            const isMainFile = fileName === sessionId;

            // Add to session map (use eventWithSession for metadata, not firstEvent!)
            if (!sessionMap.has(sessionId)) {
              sessionMap.set(sessionId, {
                files: [],
                metadata: {
                  cwd: eventWithSession.cwd,
                  gitBranch: eventWithSession.gitBranch,
                  version: eventWithSession.version,
                  timestamp: eventWithSession.timestamp
                }
              });
            }

            // Add main file first, agent files after
            if (isMainFile) {
              sessionMap.get(sessionId)!.files.unshift(filePath);
            } else {
              sessionMap.get(sessionId)!.files.push(filePath);
            }
          } catch (error) {
            console.error(`Failed to read session file ${filePath}: ${error}`);
          }
        }
      }
    } catch (error) {
      console.error(`Error scanning Claude sessions: ${error}`);
    }

    // Convert map to descriptors
    for (const [sessionId, data] of sessionMap.entries()) {
      // Resolve project path from cwd or use encoded directory name
      const projectPath = data.metadata.cwd as string || '';

      descriptors.push({
        sessionId,
        agent: this.agentName,
        filePaths: data.files,
        metadata: {
          ...data.metadata,
          projectPath
        }
      });
    }

    // Apply pagination using inherited method
    return this.applyPagination(descriptors, options);
  }

  async extractSession(descriptor: SessionDescriptor): Promise<CodemieSession> {
    // Read all JSONL files for this session
    const allEvents: ClaudeEvent[] = [];
    for (const filePath of descriptor.filePaths) {
      const events = await readJSONL(filePath);
      allEvents.push(...(events as ClaudeEvent[]));
    }

    // Extract session metadata from first event
    const firstEvent = allEvents.find(e => e.type === 'user' || e.type === 'assistant') || allEvents[0];
    const lastEvent = allEvents[allEvents.length - 1];

    const startTime = new Date(firstEvent?.timestamp || Date.now());
    const endTime = new Date(lastEvent?.timestamp || Date.now());
    const durationMs = endTime.getTime() - startTime.getTime();

    // Count messages by type
    const userMessages = allEvents.filter(e => e.type === 'user');
    const assistantMessages = allEvents.filter(e => e.type === 'assistant');

    // Extract tool calls and their statuses
    const toolCalls = await this.extractToolCallsFromEvents(allEvents, descriptor.sessionId);
    const successfulToolCalls = toolCalls.filter(tc => tc.status === 'success').length;
    const failedToolCalls = toolCalls.filter(tc => tc.status === 'failure').length;

    // Track tool usage and status
    const toolUsage: Record<string, number> = {};
    const toolStatus: Record<string, { success: number; failure: number }> = {};

    for (const tc of toolCalls) {
      toolUsage[tc.toolName] = (toolUsage[tc.toolName] || 0) + 1;

      if (!toolStatus[tc.toolName]) {
        toolStatus[tc.toolName] = { success: 0, failure: 0 };
      }
      if (tc.status === 'success') {
        toolStatus[tc.toolName].success++;
      } else if (tc.status === 'failure') {
        toolStatus[tc.toolName].failure++;
      }
    }

    // Track model usage (count messages per model)
    const modelUsage: Record<string, number> = {};
    for (const event of assistantMessages) {
      if (event.message?.model) {
        modelUsage[event.message.model] = (modelUsage[event.message.model] || 0) + 1;
      }
    }

    // Extract file modifications
    const fileModifications = await this.extractFileModifications(descriptor);

    // Sum tokens with detailed breakdown
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalTokens = 0;

    for (const event of assistantMessages) {
      if (event.message?.usage) {
        const usage = event.message.usage;
        totalInputTokens += usage.input_tokens || 0;
        totalOutputTokens += usage.output_tokens || 0;
        totalCacheReadTokens += usage.cache_read_input_tokens || 0;
        totalCacheCreationTokens += usage.cache_creation_input_tokens || 0;

        // Total includes all token types
        totalTokens += (usage.input_tokens || 0) +
                      (usage.output_tokens || 0) +
                      (usage.cache_read_input_tokens || 0) +
                      (usage.cache_creation_input_tokens || 0);
      }
    }

    // Check for errors
    const hadErrors = failedToolCalls > 0;

    // Extract model (from first assistant message)
    const model = assistantMessages.find(m => m.message?.model)?.message?.model || 'claude-sonnet-4-5-20250929';

    // Calculate file statistics using shared utility
    const fileStats = calculateFileStats(fileModifications);

    // Get project path from descriptor metadata or cwd
    const projectPath = (descriptor.metadata.projectPath as string) ||
                       (descriptor.metadata.cwd as string) || '';

    return {
      sessionId: descriptor.sessionId,
      agent: 'claude',
      agentVersion: (descriptor.metadata.version as string) || '2.0.0',
      startTime,
      endTime,
      durationMs,
      projectPath,
      gitBranch: descriptor.metadata.gitBranch as string,
      model,
      provider: 'anthropic',
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      toolCallCount: toolCalls.length,
      successfulToolCalls,
      failedToolCalls,
      fileModifications: fileModifications.length,
      toolUsage,
      toolStatus,
      modelUsage,
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        cacheRead: totalCacheReadTokens,
        cacheCreation: totalCacheCreationTokens,
        total: totalTokens
      },
      hadErrors,
      fileStats
    };
  }

  async extractMessages(descriptor: SessionDescriptor): Promise<CodemieMessage[]> {
    const allEvents: ClaudeEvent[] = [];
    for (const filePath of descriptor.filePaths) {
      const events = await readJSONL(filePath);
      allEvents.push(...(events as ClaudeEvent[]));
    }

    const messages: CodemieMessage[] = [];

    for (const event of allEvents) {
      if (event.type === 'user' || event.type === 'assistant') {
        // Extract content text
        let content = '';
        if (event.message?.content) {
          if (typeof event.message.content === 'string') {
            content = event.message.content;
          } else if (Array.isArray(event.message.content)) {
            // Join text blocks
            content = event.message.content
              .filter((c): c is ClaudeTextContent => c.type === 'text')
              .map(c => c.text)
              .join('\n');
          }
        }

        // Extract tool calls from content array
        const toolCalls: CodemieToolCall[] = [];
        if (Array.isArray(event.message?.content)) {
          const toolUseBlocks = event.message.content.filter(
            (c): c is ClaudeToolUseContent => c.type === 'tool_use'
          );

          for (const toolUse of toolUseBlocks) {
            // Find corresponding tool result
            const toolResult = allEvents.find(
              e => Array.isArray(e.message?.content) &&
                   e.message.content.some(
                     (c): c is ClaudeToolResultContent =>
                       c.type === 'tool_result' && c.tool_use_id === toolUse.id
                   )
            );

            const resultBlock = (Array.isArray(toolResult?.message?.content) ?
              toolResult.message.content.find(
                (c): c is ClaudeToolResultContent =>
                  c.type === 'tool_result' && c.tool_use_id === toolUse.id
              ) : undefined) as ClaudeToolResultContent | undefined;

            // Detect file modifications
            const modifiedFiles: string[] = [];
            if (['Write', 'Edit', 'Create'].some(op => toolUse.name.includes(op))) {
              const filePath = toolUse.input.file_path || toolUse.input.path;
              if (filePath && typeof filePath === 'string') {
                modifiedFiles.push(filePath);
              }
            }

            toolCalls.push({
              toolCallId: toolUse.id,
              messageId: event.uuid,
              sessionId: descriptor.sessionId,
              timestamp: new Date(event.timestamp),
              toolName: toolUse.name,
              toolArgs: toolUse.input,
              status: resultBlock?.is_error ? 'failure' : 'success',
              result: resultBlock?.content,
              modifiedFiles: modifiedFiles.length > 0 ? modifiedFiles : undefined
            });
          }
        }

        messages.push({
          messageId: event.uuid,
          sessionId: descriptor.sessionId,
          timestamp: new Date(event.timestamp),
          role: event.message?.role || 'user',
          content,
          tokens: event.message?.usage ? {
            input: event.message.usage.input_tokens,
            output: event.message.usage.output_tokens,
            cacheRead: event.message.usage.cache_read_input_tokens,
            cacheCreation: event.message.usage.cache_creation_input_tokens,
            total: (event.message.usage.input_tokens || 0) +
                  (event.message.usage.output_tokens || 0) +
                  (event.message.usage.cache_read_input_tokens || 0) +
                  (event.message.usage.cache_creation_input_tokens || 0)
          } : undefined,
          model: event.message?.model,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        });
      }
    }

    return messages;
  }

  /**
   * Extract tool calls from events (internal helper)
   */
  private async extractToolCallsFromEvents(
    events: ClaudeEvent[],
    sessionId: string
  ): Promise<CodemieToolCall[]> {
    const toolCalls: CodemieToolCall[] = [];

    for (const event of events) {
      if (Array.isArray(event.message?.content)) {
        const toolUseBlocks = event.message.content.filter(
          (c): c is ClaudeToolUseContent => c.type === 'tool_use'
        );

        for (const toolUse of toolUseBlocks) {
          // Find corresponding tool result
          const toolResult = events.find(
            e => Array.isArray(e.message?.content) &&
                 e.message.content.some(
                   (c): c is ClaudeToolResultContent =>
                     c.type === 'tool_result' && c.tool_use_id === toolUse.id
                 )
          );

          const resultBlock = (Array.isArray(toolResult?.message?.content) ?
            toolResult.message.content.find(
              (c): c is ClaudeToolResultContent =>
                c.type === 'tool_result' && c.tool_use_id === toolUse.id
            ) : undefined) as ClaudeToolResultContent | undefined;

          // Detect file modifications
          const modifiedFiles: string[] = [];
          if (['Write', 'Edit', 'Create'].some(op => toolUse.name.includes(op))) {
            const filePath = toolUse.input.file_path || toolUse.input.path;
            if (filePath && typeof filePath === 'string') {
              modifiedFiles.push(filePath);
            }
          }

          toolCalls.push({
            toolCallId: toolUse.id,
            messageId: event.uuid,
            sessionId,
            timestamp: new Date(event.timestamp),
            toolName: toolUse.name,
            toolArgs: toolUse.input,
            status: resultBlock?.is_error ? 'failure' : 'success',
            result: resultBlock?.content,
            modifiedFiles: modifiedFiles.length > 0 ? modifiedFiles : undefined
          });
        }
      }
    }

    return toolCalls;
  }

  async extractToolCalls(descriptor: SessionDescriptor): Promise<CodemieToolCall[]> {
    const allEvents: ClaudeEvent[] = [];
    for (const filePath of descriptor.filePaths) {
      const events = await readJSONL(filePath);
      allEvents.push(...(events as ClaudeEvent[]));
    }

    return this.extractToolCallsFromEvents(allEvents, descriptor.sessionId);
  }

  /**
   * Calculate metrics for Write operations
   */
  private calculateWriteMetrics(
    toolUse: ClaudeToolUseContent,
    result: ClaudeToolResultContent | undefined
  ): Pick<CodemieFileModification, 'linesAdded' | 'linesRemoved' | 'linesModified' | 'sizeBytes' | 'wasNewFile'> {
    const content = toolUse.input.content as string || '';
    const lines = countLines(content);
    const bytes = calculateByteSize(content);

    // Check if file was newly created (from result message)
    let wasNewFile = false;
    if (result && typeof result.content === 'string') {
      wasNewFile = result.content.toLowerCase().includes('created') ||
                   result.content.toLowerCase().includes('new file');
    }

    return {
      linesAdded: lines,
      linesRemoved: wasNewFile ? 0 : 0, // Can't determine removed lines without file system access
      linesModified: 0,
      sizeBytes: bytes,
      wasNewFile
    };
  }

  /**
   * Calculate metrics for Edit operations
   */
  private calculateEditMetrics(
    toolUse: ClaudeToolUseContent
  ): Pick<CodemieFileModification, 'linesAdded' | 'linesRemoved' | 'linesModified' | 'wasNewFile'> {
    const oldString = toolUse.input.old_string as string || '';
    const newString = toolUse.input.new_string as string || '';

    const oldLines = countLines(oldString);
    const newLines = countLines(newString);

    return {
      linesAdded: Math.max(0, newLines - oldLines),
      linesRemoved: Math.max(0, oldLines - newLines),
      linesModified: Math.min(oldLines, newLines),
      wasNewFile: false // edit only works on existing files
    };
  }

  async extractFileModifications(descriptor: SessionDescriptor): Promise<CodemieFileModification[]> {
    const allEvents: ClaudeEvent[] = [];
    for (const filePath of descriptor.filePaths) {
      const events = await readJSONL(filePath);
      allEvents.push(...(events as ClaudeEvent[]));
    }

    const modifications: CodemieFileModification[] = [];

    // Extract from tool calls
    for (const event of allEvents) {
      if (Array.isArray(event.message?.content)) {
        const toolUseBlocks = event.message.content.filter(
          (c): c is ClaudeToolUseContent => c.type === 'tool_use'
        );

        for (const toolUse of toolUseBlocks) {
          // Check if this is a file modification tool
          if (['Write', 'Edit', 'Create', 'NotebookEdit'].some(op => toolUse.name.includes(op))) {
            const targetFilePath = toolUse.input.file_path as string ||
                                  toolUse.input.path as string ||
                                  toolUse.input.notebook_path as string;
            if (!targetFilePath) continue;

            // Find corresponding result
            const toolResult = allEvents.find(
              e => Array.isArray(e.message?.content) &&
                   e.message.content.some(
                     (c): c is ClaudeToolResultContent =>
                       c.type === 'tool_result' && c.tool_use_id === toolUse.id
                   )
            );

            const resultBlock = (Array.isArray(toolResult?.message?.content) ?
              toolResult.message.content.find(
                (c): c is ClaudeToolResultContent =>
                  c.type === 'tool_result' && c.tool_use_id === toolUse.id
              ) : undefined) as ClaudeToolResultContent | undefined;

            // Calculate metrics based on tool type
            let metrics: Pick<CodemieFileModification, 'linesAdded' | 'linesRemoved' | 'linesModified' | 'sizeBytes' | 'wasNewFile'>;

            if (toolUse.name.includes('Write') || toolUse.name.includes('Create')) {
              metrics = this.calculateWriteMetrics(toolUse, resultBlock);
            } else if (toolUse.name.includes('Edit')) {
              metrics = {
                ...this.calculateEditMetrics(toolUse),
                sizeBytes: toolUse.input.new_string ?
                          calculateByteSize(toolUse.input.new_string as string) :
                          undefined
              };
            } else {
              continue; // Skip unknown tools
            }

            // Determine operation type
            let operation: 'create' | 'update' | 'delete' = 'update';
            if (metrics.wasNewFile || toolUse.name.includes('Create')) {
              operation = 'create';
            } else if (toolUse.name.includes('Delete')) {
              operation = 'delete';
            }

            // Detect language and format
            const fileExtension = extname(targetFilePath);
            const language = detectLanguage(targetFilePath);
            const format = detectFormat(targetFilePath);

            modifications.push({
              sessionId: descriptor.sessionId,
              toolCallId: toolUse.id,
              timestamp: new Date(event.timestamp),
              filePath: targetFilePath,
              operation,
              linesAdded: metrics.linesAdded,
              linesRemoved: metrics.linesRemoved,
              linesModified: metrics.linesModified,
              sizeBytes: metrics.sizeBytes,
              toolName: toolUse.name,
              wasNewFile: metrics.wasNewFile,
              fileExtension,
              language,
              format
            });
          }
        }
      }
    }

    // Also extract from file-history-snapshot events (alternative source)
    const snapshotEvents = allEvents.filter(e => e.type === 'file-history-snapshot');
    for (const event of snapshotEvents) {
      if (event.snapshot?.trackedFileBackups) {
        // Each backup represents a modification
        for (const [filePath] of Object.entries(event.snapshot.trackedFileBackups)) {
          const fileExtension = extname(filePath);
          const language = detectLanguage(filePath);
          const format = detectFormat(filePath);

          modifications.push({
            sessionId: descriptor.sessionId,
            toolCallId: event.uuid,
            timestamp: new Date(event.snapshot.timestamp),
            filePath,
            operation: 'update',
            linesAdded: 0, // Can't determine from snapshot
            linesRemoved: 0,
            linesModified: 0,
            toolName: 'file-history-snapshot',
            wasNewFile: false,
            fileExtension,
            language,
            format
          });
        }
      }
    }

    return modifications;
  }
}
