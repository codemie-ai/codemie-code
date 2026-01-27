// src/agents/plugins/opencode/opencode.session.ts
import { readFile, readdir, stat } from 'fs/promises';
import { join, dirname, sep } from 'path';
import { existsSync } from 'fs';
import type { SessionAdapter, ParsedSession, AggregatedResult, SessionDiscoveryOptions, SessionDescriptor } from '../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext } from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import type {
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodeAssistantMessage
} from './opencode-message-types.js';
import { getOpenCodeSessionsPath } from './opencode.paths.js';
import { logger } from '../../../utils/logger.js';
import { OpenCodeMetricsProcessor } from './session/processors/opencode.metrics-processor.js';
import { OpenCodeConversationsProcessor } from './session/processors/opencode.conversations-processor.js';

// Retry config per tech spec "F10 FIX" (FIXED per GPT-5.5 review):
// - 1 initial read + 3 retries = 4 total read attempts
// - Retry on ENOENT (file not found during concurrent write) and SyntaxError (partial JSON)
// - Sleep delays AFTER each failed attempt: 50ms, 100ms, 200ms
// - Total budget ~350ms (50+100+200 = 350ms of sleep time)
const RETRY_CONFIG = {
  maxAttempts: 4,           // 1 initial + 3 retries
  delays: [50, 100, 200],   // Sleep after attempts 1, 2, 3 (not after attempt 4)
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read JSON file with retry on concurrent write errors
 * Per tech spec "F10 FIX" (FIXED per GPT-5.5 review):
 * - 1 initial + 3 retries = 4 total attempts
 * - Sleep 50/100/200ms after each failed attempt (except last)
 */
async function readJsonWithRetry<T>(filePath: string): Promise<T | null> {
  for (let attempt = 0; attempt < RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      // Check for retryable errors:
      // - ENOENT: file temporarily missing during concurrent write
      // - SyntaxError: partial JSON from interrupted write
      const isRetryable = err.code === 'ENOENT' || err.name === 'SyntaxError';

      if (!isRetryable) {
        // Non-retryable error, fail immediately
        return null;
      }

      // Sleep before next attempt (if not last attempt)
      // attempt 0 -> sleep 50ms, attempt 1 -> sleep 100ms, attempt 2 -> sleep 200ms
      if (attempt < RETRY_CONFIG.maxAttempts - 1) {
        await sleep(RETRY_CONFIG.delays[attempt]);
      }
    }
  }
  // All 4 attempts exhausted
  return null;
}

/**
 * OpenCode Session Adapter
 *
 * Parses OpenCode session files from ~/.local/share/opencode/storage/
 * Implements SessionAdapter interface with processor chain pattern.
 */
export class OpenCodeSessionAdapter implements SessionAdapter {
  readonly agentName = 'opencode';
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    if (!metadata.dataPaths?.home) {
      throw new Error('Agent metadata must provide dataPaths.home');
    }
    this.initializeProcessors();
  }

  /**
   * Initialize processors for this adapter.
   * Processors run in priority order: metrics (1), conversations (2)
   */
  private initializeProcessors(): void {
    this.registerProcessor(new OpenCodeMetricsProcessor());
    this.registerProcessor(new OpenCodeConversationsProcessor());
    logger.debug(`[opencode-adapter] Initialized ${this.processors.length} processors`);
  }

  /**
   * Register a processor to run during session processing.
   */
  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[opencode-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
  }

  /**
   * Parse OpenCode session file to unified ParsedSession format.
   *
   * UPDATED (GPT-5.9): OpenCode uses numeric timestamps (time.created/time.updated)
   * not ISO strings. We convert to ISO for CodeMie's canonical format.
   */
  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    try {
      // Validate path shape before proceeding (GPT-5.8 fix)
      // Expected: .../storage/session/{projectId}/{sessionId}.json
      if (!this.isValidSessionPath(filePath)) {
        logger.warn(`[opencode-adapter] Unexpected session path format: ${filePath}`);
        // Continue anyway, but path calculations may fail
      }

      // Read session JSON
      const session = await readJsonWithRetry<OpenCodeSession>(filePath);
      if (!session) {
        throw new Error(`Failed to read session file: ${filePath}`);
      }

      // Load messages from message/{sessionId}/*.json
      const messages = await this.loadMessages(filePath, session.id);

      // Extract metrics from messages
      const metrics = this.extractMetrics(messages);

      logger.debug(
        `[opencode-adapter] Parsed session ${sessionId}: ${messages.length} messages, ` +
        `${metrics?.tokens?.input || 0} input tokens, ${metrics?.tokens?.output || 0} output tokens`
      );

      // UPDATED (GPT-5.9): Convert numeric timestamps to ISO strings
      // OpenCode uses time.created/time.updated (numbers in ms)
      // CodeMie ParsedSession expects ISO strings
      // UPDATED (GPT-5.11): Use session.directory if available for projectPath
      // UPDATED (tech-spec ADR-1): Add storagePath and openCodeSessionId for metrics processor
      const storagePath = dirname(dirname(dirname(filePath)));

      // Build metadata with OpenCode-specific extensions (ADR-1)
      // Cast to `any` to allow custom fields within OpenCode plugin boundary
      const metadata: any = {
        // Prefer session.directory (actual path) over extracted projectId (hash)
        projectPath: session.directory || this.extractProjectPath(filePath),
        createdAt: session.time?.created
          ? new Date(session.time.created).toISOString()
          : undefined,
        updatedAt: session.time?.updated
          ? new Date(session.time.updated).toISOString()
          : undefined,
        // Per tech spec ADR-1: Expose storage path and OpenCode session ID for metrics processor
        storagePath,
        openCodeSessionId: session.id,
        openCodeVersion: session.version
      };

      return {
        sessionId,
        agentName: this.metadata.displayName || 'opencode',
        metadata,
        messages,  // Raw messages for processors
        metrics
      };
    } catch (error) {
      logger.error(`[opencode-adapter] Failed to parse session file ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Validate session path has expected structure (GPT-5.8 fix, updated GPT-5.10/5.11)
   * Expected: .../storage/session/{projectId}/{sessionId}.json
   *
   * FIXED (GPT-5.10/5.11): Use path.sep for cross-platform compatibility
   */
  private isValidSessionPath(filePath: string): boolean {
    // Handle both platform-specific separators and forward slashes
    const parts = filePath.split(sep);
    const partsAlt = filePath.split('/');
    const effectiveParts = parts.length > partsAlt.length ? parts : partsAlt;

    // Should have at least: .../, storage, session, {projectId}, {sessionId}.json
    const sessionIdx = effectiveParts.indexOf('session');
    if (sessionIdx === -1) return false;
    // session should be followed by projectId and sessionId.json
    return effectiveParts.length > sessionIdx + 2;
  }

  /**
   * Extract project path from session file path
   * Session path: .../storage/session/{projectId}/{sessionId}.json
   * Project ID is typically git root commit hash
   *
   * FIXED (GPT-5.10/5.11): Use path module for cross-platform compatibility
   * UPDATED (GPT-5.11): Prefer session.directory over path extraction when available
   */
  private extractProjectPath(filePath: string): string | undefined {
    // Handle both platform-specific separators and forward slashes
    const parts = filePath.split(sep);
    const partsAlt = filePath.split('/');
    const effectiveParts = parts.length > partsAlt.length ? parts : partsAlt;

    const sessionIdx = effectiveParts.indexOf('session');
    if (sessionIdx !== -1 && effectiveParts.length > sessionIdx + 1) {
      // Return projectId (may be git hash or 'global')
      return effectiveParts[sessionIdx + 1];
    }
    return undefined;
  }

  /**
   * Load messages for a session from message/{sessionId}/*.json
   *
   * Path calculation (FIXED per GPT-5.5 review):
   * - sessionFilePath = .../storage/session/{projectId}/{sessionId}.json
   * - dirname(sessionFilePath) = .../storage/session/{projectId}
   * - dirname(dirname(sessionFilePath)) = .../storage/session
   * - dirname(dirname(dirname(sessionFilePath))) = .../storage  ← CORRECT base
   * - messagesDir = .../storage/message/{sessionId}
   */
  private async loadMessages(sessionFilePath: string, sessionId: string): Promise<OpenCodeMessage[]> {
    // Go up THREE levels from session/{projectId}/{sessionId}.json to get to storage/
    const storagePath = dirname(dirname(dirname(sessionFilePath)));
    const messagesDir = join(storagePath, 'message', sessionId);

    if (!existsSync(messagesDir)) {
      return [];
    }

    const messages: OpenCodeMessage[] = [];
    try {
      const files = await readdir(messagesDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const msg = await readJsonWithRetry<OpenCodeMessage>(join(messagesDir, file));
        if (msg) messages.push(msg);
      }
    } catch {
      logger.debug(`[opencode-adapter] No messages directory: ${messagesDir}`);
    }

    // UPDATED (GPT-5.9): Sort by time.created (numeric timestamp)
    return messages.sort((a, b) => {
      const aTime = a.time?.created || 0;
      const bTime = b.time?.created || 0;
      return aTime - bTime;
    });
  }

  /**
   * Extract metrics from OpenCode messages.
   *
   * UPDATED (GPT-5.9): Use isAssistantMessage type guard for safe access
   * to assistant-specific fields (tokens, cost, etc.)
   */
  private extractMetrics(messages: OpenCodeMessage[]): ParsedSession['metrics'] {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const toolCounts: Record<string, number> = {};

    for (const msg of messages) {
      // UPDATED (GPT-5.9): Type-safe access to assistant message fields
      if (msg.role === 'assistant') {
        const assistantMsg = msg as OpenCodeAssistantMessage;
        if (assistantMsg.tokens) {
          inputTokens += assistantMsg.tokens.input || 0;
          outputTokens += assistantMsg.tokens.output || 0;
          cacheReadTokens += assistantMsg.tokens.cache?.read || 0;
          cacheWriteTokens += assistantMsg.tokens.cache?.write || 0;
        }
      }
      // Tool counting would require loading parts - defer to processor
    }

    return {
      tokens: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens
      },
      tools: toolCounts,
      toolStatus: {},
      fileOperations: []
    };
  }

  /**
   * Process session with all registered processors.
   */
  async processSession(
    filePath: string,
    sessionId: string,
    context: ProcessingContext
  ): Promise<AggregatedResult> {
    try {
      logger.debug(`[opencode-adapter] Processing session ${sessionId} with ${this.processors.length} processors`);

      // 1. Parse session once
      const parsedSession = await this.parseSessionFile(filePath, sessionId);

      // 2. Run processors in priority order
      const processorResults: Record<string, {
        success: boolean;
        message?: string;
        recordsProcessed?: number;
      }> = {};
      const failedProcessors: string[] = [];
      let totalRecords = 0;

      for (const processor of this.processors) {
        try {
          if (!processor.shouldProcess(parsedSession)) {
            logger.debug(`[opencode-adapter] Processor ${processor.name} skipped`);
            continue;
          }

          logger.debug(`[opencode-adapter] Running processor: ${processor.name}`);
          const result = await processor.process(parsedSession, context);

          processorResults[processor.name] = {
            success: result.success,
            message: result.message,
            recordsProcessed: result.metadata?.recordsProcessed as number | undefined
          };

          if (!result.success) {
            failedProcessors.push(processor.name);
            logger.warn(`[opencode-adapter] Processor ${processor.name} failed: ${result.message}`);
          }

          const recordsProcessed = result.metadata?.recordsProcessed as number | undefined;
          if (typeof recordsProcessed === 'number') {
            totalRecords += recordsProcessed;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[opencode-adapter] Processor ${processor.name} threw:`, error);
          processorResults[processor.name] = { success: false, message: errorMessage };
          failedProcessors.push(processor.name);
        }
      }

      return {
        success: failedProcessors.length === 0,
        processors: processorResults,
        totalRecords,
        failedProcessors
      };
    } catch (error) {
      logger.error(`[opencode-adapter] Session processing failed:`, error);
      throw error;
    }
  }

  /**
   * Discover OpenCode sessions with filtering
   *
   * Scans XDG_DATA_HOME/opencode/storage/session/{projectID}/{sessionID}.json
   * Applies 30-day default filter and optional cwd filter.
   */
  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    const sessionsPath = getOpenCodeSessionsPath();

    if (!sessionsPath) {
      logger.debug('[opencode-discovery] Sessions path not found (OpenCode not installed?)');
      return [];
    }

    // Calculate cutoff timestamp
    const maxAgeDays = options?.maxAgeDays ?? 30;  // Default: 30 days
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoffTimestamp = Date.now() - maxAgeMs;

    // Normalize cwd for comparison (remove trailing slash)
    const normalizedCwd = options?.cwd?.replace(/\/+$/, '');

    const results: SessionDescriptor[] = [];

    try {
      // Scan project directories
      const projectDirs = await readdir(sessionsPath);

      for (const projectId of projectDirs) {
        const projectPath = join(sessionsPath, projectId);

        // Skip non-directories
        try {
          const projectStat = await stat(projectPath);
          if (!projectStat.isDirectory()) continue;
        } catch {
          continue;
        }

        // Scan session files in project directory
        let sessionFiles: string[];
        try {
          sessionFiles = await readdir(projectPath);
        } catch {
          continue;
        }

        for (const file of sessionFiles) {
          // Only process .json files
          if (!file.endsWith('.json')) continue;

          const filePath = join(projectPath, file);
          const sessionId = file.replace('.json', '');

          try {
            // Read session file with retry (handles concurrent writes)
            const session = await readJsonWithRetry<OpenCodeSession>(filePath);

            if (!session) {
              logger.debug(`[opencode-discovery] Skipping unreadable session: ${sessionId}`);
              continue;
            }

            // Extract timestamp (OpenCode uses numeric milliseconds)
            const createdAt = session.time?.created;
            const updatedAt = session.time?.updated;

            // Skip sessions without timestamps (unless explicitly included)
            if (typeof createdAt !== 'number') {
              if (!options?.includeTimestampless) {
                logger.debug(`[opencode-discovery] Skipping session without timestamp: ${sessionId}`);
                continue;
              }
            }

            // Apply 30-day filter
            if (typeof createdAt === 'number' && createdAt < cutoffTimestamp) {
              logger.debug(`[opencode-discovery] Skipping old session: ${sessionId} (created: ${new Date(createdAt).toISOString()})`);
              continue;
            }

            // Apply cwd filter using session.directory
            if (normalizedCwd && session.directory) {
              const normalizedDir = session.directory.replace(/\/+$/, '');
              if (normalizedDir !== normalizedCwd) {
                logger.debug(`[opencode-discovery] Skipping session from different cwd: ${sessionId} (${normalizedDir} !== ${normalizedCwd})`);
                continue;
              }
            }

            // Add to results
            results.push({
              sessionId,
              filePath,
              projectPath: session.directory,
              createdAt: createdAt ?? 0,
              updatedAt: typeof updatedAt === 'number' ? updatedAt : undefined,
              agentName: 'opencode'
            });

          } catch (error) {
            // Skip sessions that fail to parse
            logger.debug(`[opencode-discovery] Error parsing session ${sessionId}:`, error);
            continue;
          }
        }
      }

      // Sort by createdAt descending (newest first)
      results.sort((a, b) => b.createdAt - a.createdAt);

      // Apply limit
      if (options?.limit && options.limit > 0) {
        const limited = results.slice(0, options.limit);
        logger.debug(`[opencode-discovery] Found ${results.length} sessions, returning ${limited.length} (limit: ${options.limit})`);
        return limited;
      }

      logger.debug(`[opencode-discovery] Found ${results.length} sessions`);
      return results;

    } catch (error) {
      logger.error('[opencode-discovery] Failed to scan sessions directory:', error);
      return [];
    }
  }
}
