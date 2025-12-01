/**
 * Gemini CLI Analytics Adapter
 *
 * Extracts analytics data from Gemini CLI session files stored in:
 * ~/.gemini/tmp/{projectHash}/chats/session-{timestamp}-{id}.json
 */

import { join, extname } from 'node:path';
import { existsSync } from 'node:fs';
import {
  BaseAnalyticsAdapter,
  AdapterMetadata,
  resolvePath,
  findFiles,
  filterFilesByDate,
  readJSON,
  detectLanguage,
  detectFormat,
  countLines,
  calculateByteSize,
  calculateFileStats,
  resolveProjectPath
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
 * Gemini session file format
 */
interface GeminiSessionFile {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: GeminiMessage[];
}

interface GeminiMessage {
  id: string;
  timestamp: string;
  type: 'user' | 'gemini';
  content: string;
  thoughts?: string[];
  tokens?: {
    input: number;
    output: number;
    cached: number;
    thoughts: number;
    tool: number;
    total: number;
  };
  model?: string;
  toolCalls?: GeminiToolCall[];
}

interface GeminiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  status: 'success' | 'failure';
  timestamp: string;
}

/**
 * Gemini CLI analytics adapter
 */
export class GeminiAnalyticsAdapter extends BaseAnalyticsAdapter {
  constructor(metadata: AdapterMetadata) {
    super(metadata);
  }

  async findSessions(options?: SessionQueryOptions): Promise<SessionDescriptor[]> {
    const baseDir = resolvePath(this.homePath);
    const tmpDir = join(baseDir, 'tmp');

    if (!existsSync(tmpDir)) {
      return [];
    }

    const descriptors: SessionDescriptor[] = [];

    // Scan all project hash directories
    const { readdir } = await import('node:fs/promises');
    try {
      const projectDirs = await readdir(tmpDir, { withFileTypes: true });

      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) continue;

        const chatsDir = join(tmpDir, projectDir.name, 'chats');
        if (!existsSync(chatsDir)) continue;

        // Find all session files
        const sessionFiles = await findFiles(chatsDir, /^session-.*\.json$/);

        // Filter by date if specified
        let filteredFiles = sessionFiles;
        if (options?.dateFrom || options?.dateTo) {
          filteredFiles = await filterFilesByDate(sessionFiles, options.dateFrom, options.dateTo);
        }

        // Create descriptors
        for (const filePath of filteredFiles) {
          try {
            const session = await readJSON(filePath);
            descriptors.push({
              sessionId: session.sessionId,
              agent: this.agentName,
              filePaths: [filePath],
              metadata: {
                projectHash: session.projectHash,
                startTime: session.startTime,
                lastUpdated: session.lastUpdated
              }
            });
          } catch (error) {
            console.error(`Failed to read session file ${filePath}: ${error}`);
          }
        }
      }
    } catch (error) {
      console.error(`Error scanning Gemini sessions: ${error}`);
    }

    // Apply pagination using inherited method
    return this.applyPagination(descriptors, options);
  }

  async extractSession(descriptor: SessionDescriptor): Promise<CodemieSession> {
    const filePath = descriptor.filePaths[0];
    const session: GeminiSessionFile = await readJSON(filePath);

    // Count messages by type
    const userMessages = session.messages.filter(m => m.type === 'user');
    const assistantMessages = session.messages.filter(m => m.type === 'gemini');

    // Count tool calls and their statuses, track usage by tool name
    let totalToolCalls = 0;
    let successfulToolCalls = 0;
    let failedToolCalls = 0;
    const toolUsage: Record<string, number> = {};
    const toolStatus: Record<string, { success: number; failure: number }> = {};

    for (const message of session.messages) {
      if (message.toolCalls) {
        totalToolCalls += message.toolCalls.length;
        successfulToolCalls += message.toolCalls.filter(tc => tc.status === 'success').length;
        failedToolCalls += message.toolCalls.filter(tc => tc.status === 'failure').length;

        // Track tool usage and status
        for (const tc of message.toolCalls) {
          toolUsage[tc.name] = (toolUsage[tc.name] || 0) + 1;

          // Track success/failure per tool
          if (!toolStatus[tc.name]) {
            toolStatus[tc.name] = { success: 0, failure: 0 };
          }
          if (tc.status === 'success') {
            toolStatus[tc.name].success++;
          } else if (tc.status === 'failure') {
            toolStatus[tc.name].failure++;
          }
        }
      }
    }

    // Track model usage (count messages per model)
    const modelUsage: Record<string, number> = {};
    for (const message of session.messages) {
      if (message.model) {
        modelUsage[message.model] = (modelUsage[message.model] || 0) + 1;
      }
    }

    // Count file modifications (tool calls with write/edit operations)
    const fileModifications = await this.extractFileModifications(descriptor);

    // Sum tokens with detailed breakdown
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let totalThoughtsTokens = 0;
    let totalToolTokens = 0;
    let totalTokens = 0;

    for (const message of session.messages) {
      if (message.tokens) {
        totalInputTokens += message.tokens.input || 0;
        totalOutputTokens += message.tokens.output || 0;
        totalCachedTokens += message.tokens.cached || 0;
        totalThoughtsTokens += message.tokens.thoughts || 0;
        totalToolTokens += message.tokens.tool || 0;
        totalTokens += message.tokens.total || 0;
      }
    }

    // Calculate duration
    const startTime = new Date(session.startTime);
    const endTime = new Date(session.lastUpdated);
    const durationMs = endTime.getTime() - startTime.getTime();

    // Check for errors
    const hadErrors = failedToolCalls > 0;

    // Extract model (from first assistant message)
    const model = assistantMessages.find(m => m.model)?.model || 'gemini-2.5-pro';

    // Calculate file statistics using shared utility
    const fileStats = calculateFileStats(fileModifications);

    // Resolve project path from hash using mapping file
    // Mapping file: ~/.codemie/gemini-project-mappings.json
    const projectPath = descriptor.metadata.projectPath as string ||
                        (session.projectHash ? resolveProjectPath('gemini', session.projectHash) : '');

    return {
      sessionId: session.sessionId,
      agent: 'gemini',
      agentVersion: '1.0.0',
      startTime,
      endTime,
      durationMs,
      projectPath,
      projectHash: session.projectHash,
      model,
      provider: 'gemini',
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      toolCallCount: totalToolCalls,
      successfulToolCalls,
      failedToolCalls,
      fileModifications: fileModifications.length,
      toolUsage,
      toolStatus,
      modelUsage,
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        cacheRead: totalCachedTokens,
        cacheCreation: 0, // Gemini uses 'cached' for cache reads, not creation
        thoughts: totalThoughtsTokens,
        tool: totalToolTokens,
        total: totalTokens
      },
      hadErrors,
      fileStats
    };
  }

  async extractMessages(descriptor: SessionDescriptor): Promise<CodemieMessage[]> {
    const filePath = descriptor.filePaths[0];
    const session: GeminiSessionFile = await readJSON(filePath);

    return session.messages.map(msg => ({
      messageId: msg.id,
      sessionId: session.sessionId,
      timestamp: new Date(msg.timestamp),
      role: msg.type === 'user' ? 'user' : 'assistant',
      content: msg.content,
      tokens: msg.tokens ? {
        input: msg.tokens.input,
        output: msg.tokens.output,
        cacheRead: msg.tokens.cached,
        cacheCreation: 0,
        thoughts: msg.tokens.thoughts,
        tool: msg.tokens.tool,
        total: msg.tokens.total
      } : undefined,
      model: msg.model
    }));
  }

  async extractToolCalls(descriptor: SessionDescriptor): Promise<CodemieToolCall[]> {
    const filePath = descriptor.filePaths[0];
    const session: GeminiSessionFile = await readJSON(filePath);

    const toolCalls: CodemieToolCall[] = [];

    for (const message of session.messages) {
      if (message.toolCalls) {
        for (const tc of message.toolCalls) {
          // Detect file modifications
          const modifiedFiles: string[] = [];
          if (['write_file', 'edit_file', 'create_file'].includes(tc.name)) {
            const filePath = tc.args.file_path || tc.args.path;
            if (filePath && typeof filePath === 'string') {
              modifiedFiles.push(filePath);
            }
          }

          toolCalls.push({
            toolCallId: tc.id,
            messageId: message.id,
            sessionId: session.sessionId,
            timestamp: new Date(tc.timestamp),
            toolName: tc.name,
            toolArgs: tc.args,
            status: tc.status,
            result: tc.result,
            modifiedFiles: modifiedFiles.length > 0 ? modifiedFiles : undefined
          });
        }
      }
    }

    return toolCalls;
  }

  /**
   * Calculate metrics for write_file operations
   */
  private calculateWriteFileMetrics(
    toolCall: GeminiToolCall
  ): Pick<CodemieFileModification, 'linesAdded' | 'linesRemoved' | 'linesModified' | 'sizeBytes' | 'wasNewFile'> {
    const content = toolCall.args.content as string || '';
    const lines = countLines(content);
    const bytes = calculateByteSize(content);

    // Check if file was newly created (from result message)
    const resultOutput = toolCall.result?.[0]?.functionResponse?.response?.output || '';
    const wasNewFile = resultOutput.includes('Successfully created and wrote to new file');

    return {
      linesAdded: lines,
      linesRemoved: wasNewFile ? 0 : 0, // Can't determine removed lines without file system access
      linesModified: 0,
      sizeBytes: bytes,
      wasNewFile
    };
  }

  /**
   * Calculate metrics for replace operations
   */
  private calculateReplaceMetrics(
    toolCall: GeminiToolCall
  ): Pick<CodemieFileModification, 'linesAdded' | 'linesRemoved' | 'linesModified' | 'wasNewFile'> {
    const oldString = toolCall.args.old_string as string || '';
    const newString = toolCall.args.new_string as string || '';

    const oldLines = countLines(oldString);
    const newLines = countLines(newString);

    return {
      linesAdded: Math.max(0, newLines - oldLines),
      linesRemoved: Math.max(0, oldLines - newLines),
      linesModified: Math.min(oldLines, newLines),
      wasNewFile: false // replace only works on existing files
    };
  }

  async extractFileModifications(descriptor: SessionDescriptor): Promise<CodemieFileModification[]> {
    const filePath = descriptor.filePaths[0];
    const session: GeminiSessionFile = await readJSON(filePath);
    const modifications: CodemieFileModification[] = [];

    for (const message of session.messages) {
      if (message.toolCalls) {
        for (const tc of message.toolCalls) {
          // Check if this is a file modification tool
          if (['write_file', 'replace', 'smart_edit', 'edit_file', 'create_file'].includes(tc.name)) {
            const targetFilePath = tc.args.file_path as string || tc.args.path as string;
            if (!targetFilePath) continue;

            // Calculate metrics based on tool type
            let metrics: Pick<CodemieFileModification, 'linesAdded' | 'linesRemoved' | 'linesModified' | 'sizeBytes' | 'wasNewFile'>;

            if (tc.name === 'write_file' || tc.name === 'create_file') {
              metrics = this.calculateWriteFileMetrics(tc);
            } else if (tc.name === 'replace' || tc.name === 'smart_edit' || tc.name === 'edit_file') {
              metrics = {
                ...this.calculateReplaceMetrics(tc),
                sizeBytes: tc.args.new_string ? calculateByteSize(tc.args.new_string as string) : undefined
              };
            } else {
              continue; // Skip unknown tools
            }

            // Determine operation type
            let operation: 'create' | 'update' | 'delete' = 'update';
            if (metrics.wasNewFile) {
              operation = 'create';
            } else if (tc.name.includes('delete')) {
              operation = 'delete';
            }

            // Detect language and format
            const fileExtension = extname(targetFilePath);
            const language = detectLanguage(targetFilePath);
            const format = detectFormat(targetFilePath);

            modifications.push({
              sessionId: session.sessionId,
              toolCallId: tc.id,
              timestamp: new Date(tc.timestamp),
              filePath: targetFilePath,
              operation,
              linesAdded: metrics.linesAdded,
              linesRemoved: metrics.linesRemoved,
              linesModified: metrics.linesModified,
              sizeBytes: metrics.sizeBytes,
              toolName: tc.name,
              wasNewFile: metrics.wasNewFile,
              fileExtension,
              language,
              format
            });
          }
        }
      }
    }

    return modifications;
  }
}
