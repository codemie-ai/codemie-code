/**
 * Claude Session Adapter
 *
 * Parses Claude Code session files from ~/.claude/projects/
 * Extracts metrics and preserves messages for processors.
 */

import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import type { SessionAdapter, ParsedSession, AggregatedResult } from '../../core/session/BaseSessionAdapter.js';
import type { SessionDiscoveryOptions, SessionDescriptor } from '../../core/session/discovery-types.js';
import type { SessionProcessor, ProcessingContext } from '../../core/session/BaseProcessor.js';
import type { ClaudeMessage, ContentItem } from './claude-message-types.js';
import type { AgentMetadata } from '../../core/types.js';
import { readJSONL } from '../../core/session/utils/jsonl-reader.js';
import { logger } from '../../../utils/logger.js';
import { MetricsProcessor } from './session/processors/claude.metrics-processor.js';
import { ConversationsProcessor } from './session/processors/claude.conversations-processor.js';
import { extractClaudeFileOperation, type ClaudeFileOperation } from './session/claude-file-operation.js';
import { extractNamedInvocations } from './session/claude-named-invocations.js';

/**
 * Best-effort decode of a Claude Code project directory name back to a filesystem path.
 * Claude encodes the cwd by replacing every '/' with '-'; the encoding is lossy when the
 * original path contains '-', so this is only a hint (exact cwd is read from session messages).
 */
function decodeClaudeProjectDir(encoded: string): string {
  return '/' + encoded.replace(/^-+/, '').replace(/-/g, '/');
}

/**
 * Claude session adapter implementation.
 * Parses Claude-specific JSONL format into unified ParsedSession.
 * Orchestrates multiple processors that transform messages.
 *
 * ENCAPSULATION: Processors are managed internally, not exposed to plugin.
 */
export class ClaudeSessionAdapter implements SessionAdapter {
  readonly agentName = 'claude';
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
   * INTERNAL: Processors are an implementation detail of the adapter.
   */
  private initializeProcessors(): void {
    // Register metrics processor (priority 1)
    this.registerProcessor(new MetricsProcessor());

    // Register conversations processor (priority 2)
    this.registerProcessor(new ConversationsProcessor());

    logger.debug(`[claude-adapter] Initialized ${this.processors.length} processors`);
  }

  /**
   * Resolve the Claude Code projects directory (e.g. ~/.claude/projects).
   */
  private getProjectsDir(): string | null {
    const home = this.metadata.dataPaths?.home;
    if (!home) {
      return null;
    }
    return join(homedir(), home, 'projects');
  }

  /**
   * Discover native Claude Code sessions under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl.
   *
   * Each project directory name is the cwd with path separators replaced by '-'. That encoding
   * is lossy (paths containing '-' are ambiguous), so the returned `projectPath` is a best-effort
   * hint — callers that need the exact cwd should read it from the parsed session messages.
   */
  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    const projectsDir = this.getProjectsDir();
    if (!projectsDir || !existsSync(projectsDir)) {
      logger.debug('[claude-discovery] projects directory not found (Claude Code not run yet)');
      return [];
    }

    const maxAgeMs = (options?.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000;
    const cutoffMs = Date.now() - maxAgeMs;

    let projectDirs: string[];
    try {
      projectDirs = await readdir(projectsDir);
    } catch {
      return [];
    }

    const results: SessionDescriptor[] = [];
    await Promise.all(
      projectDirs.map(async (encoded) => {
        const dirPath = join(projectsDir, encoded);
        let files: string[];
        try {
          files = await readdir(dirPath);
        } catch {
          return; // not a directory / unreadable
        }
        await Promise.all(
          files.map(async (file) => {
            if (!file.endsWith('.jsonl')) {
              return;
            }
            const filePath = join(dirPath, file);
            try {
              const st = await stat(filePath);
              if (!st.isFile()) {
                return;
              }
              const mtime = st.mtime.getTime();
              if (mtime < cutoffMs) {
                return; // older than the window
              }
              results.push({
                sessionId: basename(file, '.jsonl'),
                filePath,
                projectPath: decodeClaudeProjectDir(encoded),
                createdAt: mtime,
                updatedAt: mtime,
                agentName: 'claude',
              });
            } catch {
              // skip unreadable file
            }
          })
        );
      })
    );

    let out = results;
    if (options?.cwd) {
      const want = options.cwd.replace(/\/+$/, '');
      out = out.filter((r) => (r.projectPath ?? '').replace(/\/+$/, '') === want);
    }
    out.sort((a, b) => b.createdAt - a.createdAt); // newest first
    if (options?.limit && options.limit > 0) {
      out = out.slice(0, options.limit);
    }
    return out;
  }

  /**
   * Parse Claude session file to unified format.
   * Extracts both raw messages (for conversations) and metrics (for metrics processor).
   * CRITICAL: Discovers and parses ALL sub-agent files to avoid duplicate file reading.
   */
  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    try {
      // Read main session JSONL file
      const messages = await readJSONL<ClaudeMessage>(filePath);

      // Handle empty files gracefully (new sessions, in-progress, corrupted files)
      if (messages.length === 0) {
        logger.debug(`[claude-adapter] Session file is empty: ${filePath}`);
        return {
          sessionId,
          agentName: this.metadata.displayName || 'claude',
          metadata: {
            projectPath: filePath,
            createdAt: undefined,
            updatedAt: undefined
          },
          messages: [],
          metrics: {
            tools: {},
            toolStatus: {},
            fileOperations: []
          }
        };
      }

      // Extract timestamps from first/last messages that have them
      let createdAt: string | undefined;
      let updatedAt: string | undefined;

      // Find first message with timestamp
      for (const message of messages) {
        if (message.timestamp) {
          createdAt = message.timestamp;
          break;
        }
      }

      // Find last message with timestamp (iterate backwards)
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].timestamp) {
          updatedAt = messages[i].timestamp;
          break;
        }
      }

      // Extract metadata from session
      const metadata = {
        projectPath: filePath,
        createdAt,
        updatedAt
      };

      // Extract metrics from messages
      const metrics = this.extractMetrics(messages);

      // CRITICAL: Discover and parse ALL sub-agent files
      const subagentFiles = await this.findSubagentFiles(filePath);
      const subagents: Array<{
        agentId: string;
        slug?: string;
        filePath: string;
        messages: unknown[];
      }> = [];

      for (const subagentFile of subagentFiles) {
        try {
          const subagentMessages = await readJSONL<ClaudeMessage>(subagentFile.filePath);
          subagents.push({
            agentId: subagentFile.agentId,
            filePath: subagentFile.filePath,
            messages: subagentMessages
          });

          logger.debug(
            `[claude-adapter] Parsed sub-agent ${subagentFile.agentId}: ${subagentMessages.length} messages`
          );
        } catch (error) {
          logger.warn(
            `[claude-adapter] Failed to parse sub-agent file ${subagentFile.filePath}:`,
            error
          );
          // Continue with other sub-agents even if one fails
        }
      }

      logger.debug(
        `[claude-adapter] Parsed session ${sessionId}: ${messages.length} main messages, ` +
        `${subagents.length} sub-agent${subagents.length !== 1 ? 's' : ''}`
      );

      return {
        sessionId,
        agentName: this.metadata.displayName || 'claude',
        metadata,
        messages,  // Preserve raw messages for conversations processor
        subagents: subagents.length > 0 ? subagents : undefined, // Include sub-agents if any
        metrics    // Extracted metrics for metrics processor
      };

    } catch (error) {
      logger.error(`[claude-adapter] Failed to parse session file ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Extract metrics data from Claude messages.
   * Aggregates tokens, tools, and file operations.
   */
  private extractMetrics(messages: ClaudeMessage[]) {
    const toolCounts: Record<string, number> = {};
    const toolStatus: Record<string, { success: number; failure: number }> = {};
    const fileOperations: ClaudeFileOperation[] = [];

    // tool_use_id → isError, and tool_use_id → the rich toolUseResult carried on the user
    // message that holds the matching tool_result (this is where file paths + diffs live).
    const toolResultsMap = new Map<string, boolean>();
    const toolUseResultMap = new Map<string, unknown>();

    for (const msg of messages) {
      if (msg.message?.content && Array.isArray(msg.message.content)) {
        for (const item of msg.message.content as ContentItem[]) {
          if (item.type === 'tool_result' && item.tool_use_id) {
            const isError = (item as { is_error?: boolean }).is_error === true || item.isError === true;
            toolResultsMap.set(item.tool_use_id, isError);
            if (msg.toolUseResult) {
              toolUseResultMap.set(item.tool_use_id, msg.toolUseResult);
            }
          }
        }
      }
    }

    // Aggregate tools, status, and file operations from the assistant tool_use blocks.
    for (const msg of messages) {
      if (!(msg.message?.content && Array.isArray(msg.message.content))) {
        continue;
      }
      for (const item of msg.message.content as ContentItem[]) {
        if (item.type !== 'tool_use' || !item.name || !item.id) {
          continue;
        }
        toolCounts[item.name] = (toolCounts[item.name] || 0) + 1;
        if (!toolStatus[item.name]) {
          toolStatus[item.name] = { success: 0, failure: 0 };
        }

        if (!toolResultsMap.has(item.id)) {
          continue; // unresolved tool — no status / file op yet
        }
        if (toolResultsMap.get(item.id)) {
          toolStatus[item.name].failure++;
          continue;
        }
        toolStatus[item.name].success++;
        // Use the shared extractor so re-parsed sessions get the same file ops + line counts
        // (linesAdded/linesRemoved) as live-tracked ones.
        const fileOp = extractClaudeFileOperation(
          item.name,
          (item as { input?: unknown }).input,
          toolUseResultMap.get(item.id)
        );
        if (fileOp) {
          fileOperations.push(fileOp);
        }
      }
    }

    // Named invocations (skill/agent/command names) via the shared extractor, so re-parsed
    // native sessions surface the same data the live MetricsProcessor records.
    const named = extractNamedInvocations(messages);

    return {
      tools: toolCounts,
      toolStatus,
      fileOperations,
      ...(Object.keys(named.skillInvocations).length > 0 && { skillInvocations: named.skillInvocations }),
      ...(Object.keys(named.agentInvocations).length > 0 && { agentInvocations: named.agentInvocations }),
      ...(Object.keys(named.commandInvocations).length > 0 && { commandInvocations: named.commandInvocations })
    };
  }

  /**
   * Find all agent-*.jsonl files in the subagents directory
   * @param sessionFilePath - Path to the main session file
   * @returns Array of sub-agent file info
   */
  private async findSubagentFiles(sessionFilePath: string): Promise<Array<{
    agentId: string;
    filePath: string;
  }>> {
    try {
      const parentDir = dirname(sessionFilePath);
      const filename = basename(sessionFilePath);
      const sessionId = filename.replace('.jsonl', '');

      // Look in {parentDir}/{sessionId}/subagents/
      const subagentsDir = join(parentDir, sessionId, 'subagents');

      if (!existsSync(subagentsDir)) {
        logger.debug(`[claude-adapter] Subagents directory not found: ${subagentsDir}`);
        return [];
      }

      // Find all agent-*.jsonl files
      const files = await readdir(subagentsDir);
      const agentFiles = files
        .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'))
        .map(f => ({
          agentId: f.replace('agent-', '').replace('.jsonl', ''),
          filePath: join(subagentsDir, f)
        }));

      logger.debug(
        `[claude-adapter] Found ${agentFiles.length} sub-agent file${agentFiles.length !== 1 ? 's' : ''} ` +
        `for session ${sessionId}`
      );

      return agentFiles;
    } catch (error) {
      logger.debug(`[claude-adapter] Failed to find sub-agent files:`, error);
      return [];
    }
  }

  /**
   * Register a processor to run during session processing.
   * Processors are sorted by priority (lower runs first).
   */
  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[claude-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
  }

  /**
   * Apply processor sync updates to session metadata.
   * Merges updates from all processors into session state.
   */
  private async applySyncUpdates(
    sessionId: string,
    results: Array<{ metadata?: any }>
  ): Promise<void> {
    try {
      const { SessionStore } = await import('../../core/session/SessionStore.js');
      const sessionStore = new SessionStore();
      const session = await sessionStore.loadSession(sessionId);

      if (!session) {
        logger.warn(`[claude-adapter] Session not found for sync updates: ${sessionId}`);
        return;
      }

      for (const result of results) {
        if (!result.metadata?.syncUpdates) continue;

        const { syncUpdates } = result.metadata;

        // Apply metrics updates
        if (syncUpdates.metrics) {
          session.sync ??= {};
          session.sync.metrics ??= {
            lastProcessedTimestamp: Date.now(),
            processedRecordIds: [],
            totalDeltas: 0,
            totalSynced: 0,
            totalFailed: 0
          };

          // Merge processedRecordIds (deduplicate)
          if (syncUpdates.metrics.processedRecordIds) {
            const existing = new Set(session.sync.metrics.processedRecordIds || []);
            for (const id of syncUpdates.metrics.processedRecordIds) {
              existing.add(id);
            }
            session.sync.metrics.processedRecordIds = Array.from(existing);
          }

          // Update counters (increment, don't overwrite)
          if (syncUpdates.metrics.totalDeltas !== undefined) {
            session.sync.metrics.totalDeltas = (session.sync.metrics.totalDeltas || 0) + syncUpdates.metrics.totalDeltas;
          }
          if (syncUpdates.metrics.totalSynced !== undefined) {
            session.sync.metrics.totalSynced = (session.sync.metrics.totalSynced || 0) + syncUpdates.metrics.totalSynced;
          }
          if (syncUpdates.metrics.totalFailed !== undefined) {
            session.sync.metrics.totalFailed = (session.sync.metrics.totalFailed || 0) + syncUpdates.metrics.totalFailed;
          }
          if (syncUpdates.metrics.lastProcessedTimestamp !== undefined) {
            session.sync.metrics.lastProcessedTimestamp = syncUpdates.metrics.lastProcessedTimestamp;
          }
        }

        // Apply conversations updates
        if (syncUpdates.conversations) {
          session.sync ??= {};
          session.sync.conversations ??= {
            lastSyncedMessageUuid: undefined,
            lastSyncedHistoryIndex: -1,
            totalMessagesSynced: 0,
            totalSyncAttempts: 0
          };

          // Update conversation tracking (latest wins)
          if (syncUpdates.conversations.lastSyncedMessageUuid !== undefined) {
            session.sync.conversations.lastSyncedMessageUuid =
              syncUpdates.conversations.lastSyncedMessageUuid;
          }
          if (syncUpdates.conversations.lastSyncedHistoryIndex !== undefined) {
            session.sync.conversations.lastSyncedHistoryIndex =
              Math.max(
                session.sync.conversations.lastSyncedHistoryIndex ?? -1,
                syncUpdates.conversations.lastSyncedHistoryIndex
              );
          }
          if (syncUpdates.conversations.conversationId !== undefined) {
            session.sync.conversations.conversationId = syncUpdates.conversations.conversationId;
          }
          if (syncUpdates.conversations.lastSyncAt !== undefined) {
            session.sync.conversations.lastSyncAt = syncUpdates.conversations.lastSyncAt;
          }

          // Update counters (increment, don't overwrite)
          if (syncUpdates.conversations.totalMessagesSynced !== undefined) {
            session.sync.conversations.totalMessagesSynced =
              (session.sync.conversations.totalMessagesSynced || 0) +
              syncUpdates.conversations.totalMessagesSynced;
          }
          if (syncUpdates.conversations.totalSyncAttempts !== undefined) {
            session.sync.conversations.totalSyncAttempts =
              (session.sync.conversations.totalSyncAttempts || 0) +
              syncUpdates.conversations.totalSyncAttempts;
          }
        }
      }

      // Persist session ONCE after all updates applied
      await sessionStore.saveSession(session);

      logger.debug(`[claude-adapter] Session persisted after all processors completed`);
    } catch (error) {
      logger.error(`[claude-adapter] Failed to apply sync updates:`, error);
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
      logger.debug(`[claude-adapter] Processing session ${sessionId} with ${this.processors.length} processor${this.processors.length !== 1 ? 's' : ''}`);

      // 1. Parse session file once (includes sub-agent discovery)
      const parsedSession = await this.parseSessionFile(filePath, sessionId);

      // 2. Execute processors in priority order and collect results
      const processorResults: Record<string, {
        success: boolean;
        message?: string;
        recordsProcessed?: number;
      }> = {};
      const failedProcessors: string[] = [];
      const allResults: Array<{ metadata?: any }> = [];
      let totalRecords = 0;

      for (const processor of this.processors) {
        try {
          // Check if processor should run
          if (!processor.shouldProcess(parsedSession)) {
            logger.debug(`[claude-adapter] Processor ${processor.name} skipped (shouldProcess returned false)`);
            continue;
          }

          logger.debug(`[claude-adapter] Running processor: ${processor.name}`);

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
            logger.warn(`[claude-adapter] Processor ${processor.name} failed: ${result.message}`);
          } else {
            logger.debug(`[claude-adapter] Processor ${processor.name} succeeded: ${result.message}`);
          }

          // Accumulate records
          const recordsProcessed = result.metadata?.recordsProcessed as number | undefined;
          if (typeof recordsProcessed === 'number') {
            totalRecords += recordsProcessed;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[claude-adapter] Processor ${processor.name} threw error:`, error);

          processorResults[processor.name] = {
            success: false,
            message: errorMessage
          };
          failedProcessors.push(processor.name);
        }
      }

      // 3. Apply all sync updates and persist session ONCE
      await this.applySyncUpdates(sessionId, allResults);

      // 4. Aggregate results
      const result: AggregatedResult = {
        success: failedProcessors.length === 0,
        processors: processorResults,
        totalRecords,
        failedProcessors
      };

      logger.debug(
        `[claude-adapter] Processing complete: ${result.success ? 'SUCCESS' : 'FAILED'} ` +
        `(${totalRecords} records, ${failedProcessors.length} failed processors)`
      );

      return result;
    } catch (error) {
      logger.error(`[claude-adapter] Session processing failed:`, error);
      throw error;
    }
  }
}
