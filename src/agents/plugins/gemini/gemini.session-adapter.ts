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

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { SessionAdapter, ParsedSession, AggregatedResult } from '../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import type { SessionDiscoveryOptions, SessionDescriptor } from '../../core/session/discovery-types.js';
import { logger } from '../../../utils/logger.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { GeminiMetricsProcessor } from './session/processors/gemini.metrics-processor.js';
import { GeminiConversationsProcessor } from './session/processors/gemini.conversations-processor.js';
import { getGeminiTmpRoot } from './gemini.paths.js';

const DEFAULT_MAX_AGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
  type: 'user' | 'gemini' | 'assistant';
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
      throw new ConfigurationError('Agent metadata must provide dataPaths.home');
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
   * Enumerate Gemini sessions from ~/.gemini/tmp/{hash}/chats/*.json, newest first.
   *
   * Gemini stores one JSON file per session under a project-hash directory. No reverse
   * mapping from hash to project path exists, so projectPath is always undefined.
   * Errors in any directory or file are logged at debug level and skipped — this method
   * never throws.
   */
  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    const tmpRoot = getGeminiTmpRoot();
    if (!existsSync(tmpRoot)) {
      logger.debug(`[gemini-discovery] no tmp dir at ${tmpRoot}`);
      return [];
    }

    const maxAgeDays = options?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    const cutoffMs = Date.now() - maxAgeDays * MS_PER_DAY;

    let hashDirs: string[];
    try {
      hashDirs = (await readdir(tmpRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }

    const perDir = await Promise.all(
      hashDirs.map((hash) => this.discoverHashDir(hash, tmpRoot, cutoffMs, options))
    );
    const results = perDir.flat();

    results.sort((a, b) => b.createdAt - a.createdAt);

    if (options?.limit && options.limit > 0) {
      const returning = Math.min(results.length, options.limit);
      logger.debug(`[gemini-discovery] found ${results.length} session(s), returning ${returning}`);
      return results.slice(0, options.limit);
    }

    logger.debug(`[gemini-discovery] found ${results.length} session(s)`);
    return results;
  }

  /** Collect all valid session descriptors from one project-hash directory. */
  private async discoverHashDir(
    hash: string,
    tmpRoot: string,
    cutoffMs: number,
    options?: SessionDiscoveryOptions
  ): Promise<SessionDescriptor[]> {
    const chatsDir = join(tmpRoot, hash, 'chats');
    let chatFiles: string[];
    try {
      chatFiles = (await readdir(chatsDir)).filter(
        (f) => (f.endsWith('.json') || f.endsWith('.jsonl')) && !f.includes('-marker')
      );
    } catch {
      logger.debug(`[gemini-discovery] no chats dir under hash ${hash}`);
      return [];
    }

    const descriptors = await Promise.all(
      chatFiles.map((chatFile) =>
        this.readDescriptor(join(chatsDir, chatFile), chatFile, cutoffMs, options)
      )
    );
    return descriptors.filter((d): d is SessionDescriptor => d !== null);
  }

  /** Parse one session file header and return a descriptor, or null if filtered/invalid. */
  private async readDescriptor(
    filePath: string,
    chatFile: string,
    cutoffMs: number,
    options?: SessionDiscoveryOptions
  ): Promise<SessionDescriptor | null> {
    let session: { sessionId?: string; startTime?: string; lastUpdated?: string } = {};
    try {
      if (filePath.endsWith('.jsonl')) {
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            try {
              const obj = JSON.parse(trimmed);
              if (obj.sessionId) session.sessionId = obj.sessionId;
              if (obj.startTime) session.startTime = obj.startTime;
              if (obj.lastUpdated) session.lastUpdated = obj.lastUpdated;
              if (obj.$set) {
                if (obj.$set.startTime) session.startTime = obj.$set.startTime;
                if (obj.$set.lastUpdated) session.lastUpdated = obj.$set.lastUpdated;
              }
              if (session.sessionId && session.startTime) {
                break; // Found sufficient info
              }
            } catch {
              // skip line errors
            }
          }
        }
      } else {
        session = JSON.parse(await readFile(filePath, 'utf-8'));
      }
    } catch {
      logger.debug(`[gemini-discovery] skipping malformed file: ${filePath}`);
      return null;
    }

    const createdAt = session.startTime ? Date.parse(session.startTime) : NaN;
    if (Number.isNaN(createdAt)) {
      if (!options?.includeTimestampless) return null;
    } else if (createdAt < cutoffMs) {
      return null;
    }

    const updatedAtMs = session.lastUpdated ? Date.parse(session.lastUpdated) : NaN;

    return {
      sessionId: session.sessionId ?? chatFile.replace(/\.(json|jsonl)$/, ''),
      filePath,
      projectPath: undefined,
      createdAt: Number.isNaN(createdAt) ? 0 : createdAt,
      updatedAt: !Number.isNaN(updatedAtMs) ? updatedAtMs : undefined,
      agentName: this.agentName,
    };
  }

  /**
   * Parse Gemini session file to unified format.
   * Reads JSON or JSONL file and extracts both raw messages and metrics.
   */
  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    try {
      let sessionData: GeminiSessionFile;

      if (filePath.endsWith('.jsonl')) {
        const content = await readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n');

        let sessionIdFromData = sessionId;
        let projectHash = '';
        let startTime = '';
        let lastUpdated = '';
        const messageMap = new Map<string, GeminiMessage>();
        let insertIndex = 0;

        const upsertMessage = (msg: any) => {
          if (!msg || !msg.id) return;
          const existing = messageMap.get(msg.id);
          if (existing) {
            if (msg.content !== undefined) {
              existing.content = msg.content;
            }
            if (msg.toolCalls !== undefined) {
              existing.toolCalls = msg.toolCalls;
            }
            if (msg.tokens !== undefined) {
              existing.tokens = msg.tokens;
            }
            if (msg.thoughts !== undefined) {
              existing.thoughts = msg.thoughts;
            }
            if (msg.model !== undefined) {
              existing.model = msg.model;
            }
            if (msg.type !== undefined) {
              existing.type = msg.type;
            }
            if (msg.timestamp !== undefined) {
              existing.timestamp = msg.timestamp;
            }
          } else {
            messageMap.set(msg.id, { ...msg, _index: insertIndex++ } as any);
          }
        };

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const lineData = JSON.parse(trimmed);
            if (lineData.sessionId) sessionIdFromData = lineData.sessionId;
            if (lineData.projectHash) projectHash = lineData.projectHash;
            if (lineData.startTime) startTime = lineData.startTime;
            if (lineData.lastUpdated) lastUpdated = lineData.lastUpdated;

            if (lineData.$set) {
              if (Array.isArray(lineData.$set.messages)) {
                for (const msg of lineData.$set.messages) {
                  upsertMessage(msg);
                }
              }
              if (lineData.$set.lastUpdated) lastUpdated = lineData.$set.lastUpdated;
              if (lineData.$set.startTime) startTime = lineData.$set.startTime;
            } else if (lineData.type === 'user' || lineData.type === 'gemini' || lineData.type === 'assistant' || lineData.type === 'info') {
              upsertMessage(lineData);
            } else if (Array.isArray(lineData.messages)) {
              for (const msg of lineData.messages) {
                upsertMessage(msg);
              }
            }
          } catch {
            logger.debug(`[gemini-adapter] Skipped malformed JSONL line in ${filePath}`);
          }
        }

        const messagesList = Array.from(messageMap.values());
        messagesList.sort((a, b) => {
          const tA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const tB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          if (tA !== tB) return tA - tB;
          return (a as any)._index - (b as any)._index;
        });

        for (const m of messagesList) {
          delete (m as any)._index;
        }

        sessionData = {
          sessionId: sessionIdFromData,
          projectHash,
          startTime,
          lastUpdated,
          messages: messagesList,
        };
      } else {
        const content = await readFile(filePath, 'utf-8');
        sessionData = JSON.parse(content);
      }

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
        `${Object.keys(metrics.tools).length} tool types`
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
   * Aggregates tools and file operations.
   */
  private extractMetrics(messages: GeminiMessage[]) {
    const toolCounts: Record<string, number> = {};
    const toolStatus: Record<string, { success: number; failure: number }> = {};
    const fileOperations: Array<{
      type: 'write' | 'edit' | 'delete';
      path: string;
    }> = [];

    // Aggregate metrics from all messages
    for (const msg of messages) {
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
    const filePath = (args.file_path ?? args.path ?? args.relative_path ?? args.filePath ?? args.TargetFile ?? args.target_file) as string | undefined;
    if (!filePath) return;

    // Map tool names to operation types
    const writeTools = new Set(['create_text_file', 'mcp_serena_create_text_file', 'mcp_serena_write_file', 'write_file', 'Write', 'write_to_file']);
    const editTools = new Set([
      'replace_content', 'mcp_serena_replace_content', 'replace_in_files', 'mcp_serena_replace_in_files',
      'replace_symbol_body', 'mcp_serena_replace_symbol_body', 'insert_after_symbol', 'mcp_serena_insert_after_symbol',
      'insert_before_symbol', 'mcp_serena_insert_before_symbol', 'safe_delete_symbol', 'mcp_serena_safe_delete_symbol',
      'replace_file_content', 'replace', 'edit_file', 'Edit'
    ]);
    const deleteTools = new Set(['delete_file']);

    let opType: 'write' | 'edit' | 'delete' | undefined;
    if (writeTools.has(toolName)) opType = 'write';
    else if (editTools.has(toolName)) opType = 'edit';
    else if (deleteTools.has(toolName)) opType = 'delete';

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
   * Persist sync-state updates emitted by processors back to SessionStore.
   * Mirrors the same pattern used by ClaudeSessionAdapter and CodexSessionAdapter.
   * No-ops when the session is not found or no processor emitted syncUpdates.
   */
  private async applySyncUpdates(
    sessionId: string,
    results: ProcessingResult[]
  ): Promise<void> {
    try {
      const { SessionStore } = await import('../../core/session/SessionStore.js');
      const { applyProcessingSyncUpdates } = await import('../../core/session/sync-state-utils.js');
      const sessionStore = new SessionStore();
      const session = await sessionStore.loadSession(sessionId);

      if (!session) {
        logger.debug(`[gemini-adapter] Session not found for sync updates: ${sessionId}`);
        return;
      }

      const hasChanges = applyProcessingSyncUpdates(session, results);
      if (!hasChanges) {
        logger.debug('[gemini-adapter] No processor sync updates to persist');
        return;
      }

      await sessionStore.saveSession(session);
      logger.debug('[gemini-adapter] Session persisted after processor sync updates');
    } catch (error) {
      logger.error('[gemini-adapter] Failed to apply sync updates:', error);
      throw error;
    }
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
      const allResults: ProcessingResult[] = [];
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
          allResults.push(result);

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

      // 3. Persist any sync-state updates processors emitted
      await this.applySyncUpdates(sessionId, allResults);

      // 4. Aggregate results
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
