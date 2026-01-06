/**
 * Gemini Metrics Adapter
 *
 * Implements metrics support for Gemini CLI agent.
 * Handles Gemini-specific file formats (JSON) and parsing logic.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { BaseMetricsAdapter } from '../core/BaseMetricsAdapter.js';
import type {
  MetricSnapshot,
  MetricDelta,
  ToolCallMetric,
  FileOperation,
  FileOperationType,
  UserPrompt
} from '../core/metrics/types.js';
import { logger } from '../../utils/logger.js';
import type { AgentMetadata } from '../core/types.js';
import { getFilename } from '../../utils/paths.js';

export class GeminiMetricsAdapter extends BaseMetricsAdapter {
  // Cache projectHash from last parsed session to optimize getUserPrompts()
  private lastProjectHash: string | null = null;

  constructor(metadata: AgentMetadata) {
    super('gemini', metadata);
  }

  /**
   * Extract projectHash from Gemini session file path
   * Path format: ~/.gemini/tmp/{projectHash}/chats/session-*.json
   *
   * Uses base method extractPlaceholder() which reads from metadata template
   * Cross-platform: works on Windows/Linux/Mac
   */
  private extractProjectHashFromPath(path: string): string | null {
    return this.extractPlaceholder(path, 'projectHash');
  }

  /**
   * Check if file matches Gemini session pattern
   * Pattern: ~/.gemini/tmp/{projectHash}/chats/session-{date}-{id}.json
   * Note: Gemini uses JSON format, not JSONL
   *
   * Uses base method matchesSessionsStructure() which reads metadata.dataPaths
   * Cross-platform: works on Windows/Linux/Mac (no hardcoded path separators)
   */
  matchesSessionPattern(path: string): boolean {
    // Validate structure using metadata template: .gemini/tmp/{projectHash}/chats/
    if (!this.matchesSessionsStructure(path)) {
      return false;
    }

    // Validate filename pattern (cross-platform)
    const filename = getFilename(path);

    // Gemini pattern: session-{YYYY}-{MM}-{DD}T{HH}-{MM}-{hex8+}.json
    // Flexible hex ID matching (8+ chars) to support future format changes
    return /^session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-[a-f0-9]+\.json$/.test(filename);
  }

  /**
   * Extract session ID from Gemini file path
   * Example: ~/.gemini/tmp/abc123/chats/session-2025-12-17T11-51-e5279324.json → 2025-12-17T11-51-e5279324
   *
   * Cross-platform: uses getFilename() which handles both / and \ separators
   */
  extractSessionId(path: string): string {
    // Extract filename only (cross-platform)
    const filename = getFilename(path);

    // Remove 'session-' prefix and '.json' extension
    // Example: 'session-2025-12-17T11-51-e5279324.json' → '2025-12-17T11-51-e5279324'
    return filename.replace(/^session-/, '').replace(/\.json$/, '');
  }

  /**
   * Parse Gemini session file (JSON format) and extract metrics
   * Each message in the messages array contains a conversation turn
   */
  async parseSessionFile(path: string): Promise<MetricSnapshot> {
    try {
      // Cache projectHash for getUserPrompts() optimization
      this.lastProjectHash = this.extractProjectHashFromPath(path);

      const content = await readFile(path, 'utf-8');
      const session = JSON.parse(content);

      if (!session.messages || session.messages.length === 0) {
        throw new Error('Empty session file');
      }

      // Aggregate metrics from all messages
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;

      // Track all models
      const modelCalls = new Map<string, number>();

      // Tool tracking
      const toolCalls: ToolCallMetric[] = [];

      for (const message of session.messages) {
        // Track models
        if (message.model && message.type === 'gemini') {
          const model = message.model;
          modelCalls.set(model, (modelCalls.get(model) || 0) + 1);
        }

        // Aggregate token usage (only from gemini messages)
        if (message.type === 'gemini' && message.tokens) {
          inputTokens += message.tokens.input || 0;
          // Output = output tokens + thoughts tokens (model's internal reasoning)
          outputTokens += (message.tokens.output || 0) + (message.tokens.thoughts || 0);
          cacheReadTokens += message.tokens.cached || 0; // Gemini "cached" → CodeMie "cacheRead"

          // Extract tool calls
          if (message.toolCalls && Array.isArray(message.toolCalls)) {
            for (const toolCall of message.toolCalls) {
              // Determine status: check 'status' field first, fallback to result.success
              let status: 'success' | 'error' = 'error';
              if (toolCall.status) {
                status = toolCall.status === 'success' ? 'success' : 'error';
              } else if (toolCall.result && typeof toolCall.result.success === 'boolean') {
                status = toolCall.result.success ? 'success' : 'error';
              }

              toolCalls.push({
                id: toolCall.id,
                name: toolCall.name,
                timestamp: new Date(toolCall.timestamp).getTime(),
                status,
                input: toolCall.args,
                error: status === 'error' ? (toolCall.error || toolCall.result?.message) : undefined,
                fileOperation: this.extractFileOperation(toolCall.name, toolCall.args)
              });
            }
          }
        }
      }

      // Build aggregated tool usage summary
      const toolUsageSummary = this.buildToolUsageSummary(toolCalls);

      // Get all models
      const allModels = Array.from(modelCalls.keys());

      const snapshot: MetricSnapshot = {
        sessionId: session.sessionId || '',
        timestamp: Date.now(),

        tokens: {
          input: inputTokens,
          output: outputTokens,
          cacheRead: cacheReadTokens > 0 ? cacheReadTokens : undefined
        },

        toolCalls,
        toolUsageSummary,

        turnCount: session.messages.length,
        model: allModels.length > 0 ? allModels[0] : undefined,

        metadata: {
          totalInputTokens: inputTokens + cacheReadTokens,
          models: allModels,
          modelCalls: Object.fromEntries(modelCalls)
        }
      };

      logger.debug(
        `[GeminiMetrics] Parsed session ${session.sessionId}: ${inputTokens} input, ${outputTokens} output, ` +
        `${cacheReadTokens} cache read, ${toolCalls.length} tool calls, ${allModels.length} models`
      );

      return snapshot;
    } catch (error) {
      logger.error(`[GeminiMetrics] Failed to parse session file: ${path}`, error);
      throw error;
    }
  }

  /**
   * Parse session file and extract incremental delta records
   * Returns array of delta records for turns with token usage
   *
   * @param path - Path to Gemini session file
   * @param processedRecordIds - Set of record IDs already written to metrics
   * @param attachedUserPromptTexts - Set of user prompt texts already attached (persisted from sync state)
   */
  async parseIncrementalMetrics(
    path: string,
    processedRecordIds: Set<string> = new Set(),
    attachedUserPromptTexts: Set<string> = new Set()
  ): Promise<{
    deltas: MetricDelta[];
    lastLine: number;
    newlyAttachedPrompts: string[];
  }> {
    try {
      // Cache projectHash for getUserPrompts() optimization
      this.lastProjectHash = this.extractProjectHashFromPath(path);

      const content = await readFile(path, 'utf-8');
      const session = JSON.parse(content);

      if (!session.messages || session.messages.length === 0) {
        logger.debug(`[GeminiMetrics] Session file empty or no messages found`);
        return { deltas: [], lastLine: 0, newlyAttachedPrompts: [] };
      }

      logger.debug(`[GeminiMetrics] Analyzing session with ${session.messages.length} total message${session.messages.length !== 1 ? 's' : ''}`);

      // Load user prompts from logs.json
      const userPrompts = await this.getUserPrompts(session.sessionId);

      // Build map by messageId (sequential 0, 1, 2...) for reliable correlation
      const userPromptsByMessageId = new Map<number, UserPrompt>();
      for (const prompt of userPrompts) {
        // logs.json has messageId field (sequential) - extract from metadata if available
        const messageId = (prompt as any).messageId;
        if (typeof messageId === 'number') {
          userPromptsByMessageId.set(messageId, prompt);
        }
      }

      // Track initial size to determine newly attached prompts
      const initialAttachedCount = attachedUserPromptTexts.size;

      const deltas: MetricDelta[] = [];
      let lastUserPrompt: UserPrompt | undefined;
      let userMessageIndex = 0; // Track sequential user message count

      for (const message of session.messages) {
        // Skip already processed messages
        if (processedRecordIds.has(message.id)) {
          continue;
        }

        // Track user prompts by sequential message index
        if (message.type === 'user') {
          // Try to match by messageId first (most reliable)
          lastUserPrompt = userPromptsByMessageId.get(userMessageIndex);

          // Fallback: find by closest timestamp within ±1000ms window
          if (!lastUserPrompt && userPrompts.length > 0) {
            const timestamp = new Date(message.timestamp).getTime();
            lastUserPrompt = this.findUserPromptByTimestamp(userPrompts, timestamp, 1000);
          }

          userMessageIndex++;
        }

        // Create delta for gemini messages with tokens
        if (message.type === 'gemini' && message.tokens) {
          const tools: Record<string, number> = {};
          const toolStatus: Record<string, { success: number; failure: number }> = {};
          const fileOperations: any[] = [];
          let apiErrorMessage: string | undefined;

          // Extract tool usage
          if (message.toolCalls && Array.isArray(message.toolCalls)) {
            for (const toolCall of message.toolCalls) {
              const toolName = toolCall.name;
              tools[toolName] = (tools[toolName] || 0) + 1;

              if (!toolStatus[toolName]) {
                toolStatus[toolName] = { success: 0, failure: 0 };
              }

              // Determine status: check 'status' field first, fallback to result.success
              let isSuccess = false;
              if (toolCall.status) {
                isSuccess = toolCall.status === 'success';
              } else if (toolCall.result && typeof toolCall.result.success === 'boolean') {
                isSuccess = toolCall.result.success;
              }

              if (isSuccess) {
                toolStatus[toolName].success++;
                const fileOp = this.extractFileOperation(toolName, toolCall.args);
                if (fileOp) {
                  fileOperations.push(fileOp);
                }
              } else {
                toolStatus[toolName].failure++;
                if (!apiErrorMessage && (toolCall.error || toolCall.result?.message)) {
                  apiErrorMessage = toolCall.error || toolCall.result?.message;
                }
              }
            }
          }

          // Include user prompt if available and not already attached
          const userPrompts: Array<{ count: number; text?: string }> = [];
          if (lastUserPrompt && lastUserPrompt.display && !attachedUserPromptTexts.has(lastUserPrompt.display)) {
            userPrompts.push({
              count: 1,
              text: lastUserPrompt.display
            });
            attachedUserPromptTexts.add(lastUserPrompt.display);
            lastUserPrompt = undefined;
          }

          // Create delta record
          const delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'> = {
            recordId: message.id,
            sessionId: '', // Set by caller (MetricsOrchestrator)
            agentSessionId: session.sessionId || '',
            timestamp: message.timestamp,
            gitBranch: undefined,
            tokens: {
              input: message.tokens.input || 0,
              // Output = output tokens + thoughts tokens (model's internal reasoning)
              output: (message.tokens.output || 0) + (message.tokens.thoughts || 0),
              cacheRead: message.tokens.cached > 0 ? message.tokens.cached : undefined
            },
            tools,
            toolStatus: Object.keys(toolStatus).length > 0 ? toolStatus : undefined,
            fileOperations: fileOperations.length > 0 ? fileOperations : undefined,
            userPrompts: userPrompts.length > 0 ? userPrompts : undefined,
            apiErrorMessage,
            models: message.model ? [message.model] : undefined
          };

          deltas.push(delta as MetricDelta);
        }
      }

      // Calculate newly attached prompts
      const newlyAttachedPrompts = Array.from(attachedUserPromptTexts).slice(initialAttachedCount);

      return {
        deltas,
        lastLine: session.messages.length,
        newlyAttachedPrompts
      };
    } catch (error) {
      logger.error(`[GeminiMetrics] Failed to parse incremental metrics: ${path}`, error);
      throw error;
    }
  }

  /**
   * Get user prompts for a specific session
   * Gemini stores user prompts in logs.json in project directories
   *
   * @param sessionId - Gemini session ID
   * @param fromTimestamp - Start timestamp (Unix ms) - optional
   * @param toTimestamp - End timestamp (Unix ms) - optional
   * @returns Array of user prompts
   */
  async getUserPrompts(
    sessionId: string,
    fromTimestamp?: number,
    toTimestamp?: number
  ): Promise<UserPrompt[]> {
    try {
      if (!this.metadata?.dataPaths?.home) {
        return [];
      }

      const home = this.getHomeDir();

      // Parse sessions template to extract directory structure
      // Template: 'tmp/{projectHash}/chats' → ['tmp', '{projectHash}', 'chats']
      const sessionsParts = this.parseSessionsTemplate();
      if (sessionsParts.length === 0) {
        logger.debug('[GeminiMetrics] No sessions template configured');
        return [];
      }

      // Build path to project directories by taking segments before first placeholder
      // 'tmp/{projectHash}/chats' → 'tmp'
      const staticSegments: string[] = [];
      for (const segment of sessionsParts) {
        if (this.isDynamicSegment(segment)) {
          break; // Stop at first placeholder
        }
        staticSegments.push(segment);
      }

      // Construct base path: ~/.gemini/tmp
      const projectsBaseDir = join(home, ...staticSegments);
      if (!existsSync(projectsBaseDir)) {
        return [];
      }

      // Use cached projectHash from parseSessionFile/parseIncrementalMetrics call
      // This is always available when getUserPrompts is called from normal flow
      if (!this.lastProjectHash) {
        logger.debug('[GeminiMetrics] No projectHash available - cannot determine logs location');
        return [];
      }

      // Get user prompts filename from metadata
      if (!this.metadata?.dataPaths?.user_prompts) {
        logger.debug('[GeminiMetrics] No user_prompts path configured in metadata');
        return [];
      }

      // Build full path: ~/.gemini/tmp/{projectHash}/logs.json
      const logsPath = join(projectsBaseDir, this.lastProjectHash, this.metadata.dataPaths.user_prompts);
      if (!existsSync(logsPath)) {
        return [];
      }

      try {
        const content = await readFile(logsPath, 'utf-8');
        const logs = JSON.parse(content);

        // Validate logs structure
        if (!Array.isArray(logs)) {
          logger.debug(`[GeminiMetrics] Invalid logs.json format in ${this.lastProjectHash}: not an array`);
          return [];
        }

        const prompts = logs
          .filter((log: any) => {
            // Validate log entry has required fields
            if (!log || !log.sessionId || !log.timestamp || !log.message) {
              return false;
            }
            return log.sessionId === sessionId;
          })
          .filter((log: any) => {
            const ts = new Date(log.timestamp).getTime();
            if (isNaN(ts)) return false; // Invalid timestamp
            if (fromTimestamp && ts < fromTimestamp) return false;
            if (toTimestamp && ts > toTimestamp) return false;
            return true;
          })
          .map((log: any) => ({
            display: log.message,
            timestamp: new Date(log.timestamp).getTime(),
            project: '', // workingDirectory comes from MetricsSession
            sessionId: log.sessionId,
            messageId: log.messageId // Preserve messageId for correlation
          }));

        return prompts;
      } catch (parseError) {
        // JSON parse failed or file read error
        logger.debug(`[GeminiMetrics] Failed to parse logs.json in ${this.lastProjectHash}:`, parseError);
        return [];
      }
    } catch (error) {
      logger.debug(`[GeminiMetrics] Failed to get user prompts:`, error);
      return [];
    }
  }

  /**
   * Find user prompt by timestamp with fuzzy matching
   * Finds the closest user prompt within the tolerance window
   *
   * @param userPrompts - Array of user prompts from logs.json
   * @param targetTimestamp - Target timestamp to match (Unix ms)
   * @param toleranceMs - Tolerance window in milliseconds (default: 1000ms = ±1s)
   * @returns Closest matching user prompt or undefined
   */
  private findUserPromptByTimestamp(
    userPrompts: UserPrompt[],
    targetTimestamp: number,
    toleranceMs: number = 1000
  ): UserPrompt | undefined {
    let closestPrompt: UserPrompt | undefined;
    let closestDiff = Infinity;

    for (const prompt of userPrompts) {
      const diff = Math.abs(prompt.timestamp - targetTimestamp);
      if (diff <= toleranceMs && diff < closestDiff) {
        closestDiff = diff;
        closestPrompt = prompt;
      }
    }

    return closestPrompt;
  }

  /**
   * Extract file operation details from tool input
   *
   * @param toolName - Tool name (read_file, write_file, etc.)
   * @param input - Tool input parameters
   */
  private extractFileOperation(toolName: string, input: any): FileOperation | undefined {
    // Map Gemini tool names to operation types
    const typeMap: Record<string, FileOperationType> = {
      'read_file': 'read',
      'write_file': 'write',
      'replace': 'edit',
      'glob': 'glob',
      'search_file_content': 'grep',
      'list_directory': 'glob'  // Directory listing mapped to glob (similar operation)
    };

    const type = typeMap[toolName];
    if (!type) return undefined;

    const fileOp: FileOperation = { type };

    // Handle file_path (most tools) or dir_path (list_directory)
    const path = input?.file_path || input?.dir_path;
    if (path) {
      fileOp.path = path;
      fileOp.format = this.extractFormat(path);
      fileOp.language = this.detectLanguage(path);
    }

    if (input?.pattern) {
      fileOp.pattern = input.pattern;
    }

    // Line counts for write operations
    if (toolName === 'write_file' && input?.content) {
      fileOp.linesAdded = input.content.split('\n').length;
    }

    return fileOp;
  }

  /**
   * Gemini uses object-based watermark (message ID tracking)
   */
  getWatermarkStrategy(): 'hash' | 'line' | 'object' {
    return 'object';
  }

  /**
   * Gemini initialization delay: 500ms (same as Claude)
   */
  getInitDelay(): number {
    return 500;
  }

  /**
   * Override getDataPaths to handle dynamic projectHash pattern
   * Pattern: ~/.gemini/tmp/{projectHash}/chats/
   */
  getDataPaths(): { sessionsDir: string; settingsDir?: string } {
    const home = this.getHomeDir();

    // Parse sessions template to extract directory structure
    // Template: 'tmp/{projectHash}/chats' → ['tmp', '{projectHash}', 'chats']
    const sessionsParts = this.parseSessionsTemplate();

    // Build path by taking segments before first placeholder
    const staticSegments: string[] = [];
    for (const segment of sessionsParts) {
      if (this.isDynamicSegment(segment)) {
        break;
      }
      staticSegments.push(segment);
    }

    // Return base directory - FileSnapshotter will scan subdirectories
    // Pattern matching in matchesSessionPattern() handles the rest
    return {
      sessionsDir: staticSegments.length > 0 ? join(home, ...staticSegments) : home,
      settingsDir: home
    };
  }
}
