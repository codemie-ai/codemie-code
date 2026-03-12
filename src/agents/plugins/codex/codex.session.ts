// src/agents/plugins/codex/codex.session.ts
/**
 * Codex Session Adapter
 *
 * Implements SessionAdapter for Codex CLI rollout files.
 *
 * Rollout files are stored at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-{ISO8601}-{uuid}.jsonl
 *
 * Discovery uses mtime-based age filtering (D-3): file modification time is
 * cheaper than parsing filename timestamps and equally accurate for recency filtering.
 *
 * Parsing reads JSONL tolerantly (skip malformed lines) and extracts:
 * - session_meta: session identity, cwd, git info, cli version
 * - turn_context: actual model used (last one wins in multi-turn sessions)
 * - response_item: function_call / function_call_output for tool pairing
 * - event_msg: user messages
 *
 * References:
 * - https://github.com/openai/codex/blob/main/codex-rs/docs/cli-reference.md
 */

import { readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type {
  SessionAdapter,
  ParsedSession,
  AggregatedResult,
  SessionDiscoveryOptions,
  SessionDescriptor,
} from '../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext } from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import type {
  CodexRolloutRecord,
  CodexSessionMeta,
  CodexTurnContext,
} from './codex-message-types.js';
import { getCodexSessionsPath } from './codex.paths.js';
import { readCodexJsonlTolerant } from './codex.storage-utils.js';
import { logger } from '../../../utils/logger.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import { CodexMetricsProcessor } from './session/processors/codex.metrics-processor.js';
import { CodexConversationsProcessor } from './session/processors/codex.conversations-processor.js';

/** Regex to extract UUID from rollout filename: rollout-{ISO8601}-{uuid}.jsonl */
const ROLLOUT_UUID_REGEX = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export class CodexSessionAdapter implements SessionAdapter {
  readonly agentName = 'codex';
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    if (!metadata.dataPaths?.home) {
      throw new ConfigurationError('Agent metadata must provide dataPaths.home');
    }
    this.initializeProcessors();
  }

  private initializeProcessors(): void {
    this.registerProcessor(new CodexMetricsProcessor());
    this.registerProcessor(new CodexConversationsProcessor());
    logger.debug(`[codex-adapter] Initialized ${this.processors.length} processors`);
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[codex-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
  }

  /**
   * Discover Codex rollout files within maxAgeDays.
   *
   * Algorithm:
   * 1. Resolve base path via getCodexSessionsPath()
   * 2. Return [] if path does not exist
   * 3. Enumerate YYYY/MM/DD directories (3-level traversal)
   * 4. For each .jsonl file: extract UUID, stat mtime, apply age filter
   * 5. Return sorted by mtime descending (newest first)
   */
  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    const sessionsPath = getCodexSessionsPath();
    if (!sessionsPath) {
      logger.debug('[codex-discovery] ~/.codex/sessions not found (Codex not run yet)');
      return [];
    }

    const maxAgeDays = options?.maxAgeDays ?? 30;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoffMs = Date.now() - maxAgeMs;

    const results: SessionDescriptor[] = [];

    try {
      // Level 1: year directories
      const yearDirs = await readdir(sessionsPath);

      const yearPaths = (await Promise.all(
        yearDirs.map(async (yearDir) => {
          const yearPath = join(sessionsPath, yearDir);
          return (await isDirectory(yearPath)) ? yearPath : null;
        })
      )).filter((p): p is string => p !== null);

      await Promise.all(yearPaths.map(async (yearPath) => {
        // Level 2: month directories
        let monthDirs: string[];
        try {
          monthDirs = await readdir(yearPath);
        } catch {
          return;
        }

        const monthPaths = (await Promise.all(
          monthDirs.map(async (monthDir) => {
            const monthPath = join(yearPath, monthDir);
            return (await isDirectory(monthPath)) ? monthPath : null;
          })
        )).filter((p): p is string => p !== null);

        await Promise.all(monthPaths.map(async (monthPath) => {
          // Level 3: day directories
          let dayDirs: string[];
          try {
            dayDirs = await readdir(monthPath);
          } catch {
            return;
          }

          const dayPaths = (await Promise.all(
            dayDirs.map(async (dayDir) => {
              const dayPath = join(monthPath, dayDir);
              return (await isDirectory(dayPath)) ? dayPath : null;
            })
          )).filter((p): p is string => p !== null);

          await Promise.all(dayPaths.map(async (dayPath) => {
            // Level 4: rollout files
            let files: string[];
            try {
              files = await readdir(dayPath);
            } catch {
              return;
            }

            await Promise.all(files.map(async (file) => {
              if (!file.endsWith('.jsonl')) return;

              const match = ROLLOUT_UUID_REGEX.exec(file);
              if (!match) {
                logger.debug(`[codex-discovery] Skipping file without UUID in name: ${file}`);
                return;
              }

              const sessionUuid = match[1];
              const filePath = join(dayPath, file);

              try {
                const fileStat = await stat(filePath);
                const mtime = fileStat.mtime.getTime();

                // Age filter based on mtime (D-3)
                if (mtime < cutoffMs) {
                  logger.debug(`[codex-discovery] Skipping old rollout: ${file}`);
                  return;
                }

                results.push({
                  sessionId: sessionUuid,
                  filePath,
                  createdAt: mtime,
                  agentName: 'codex',
                });
              } catch {
                logger.debug(`[codex-discovery] Could not stat file: ${filePath}`);
              }
            }));
          }));
        }));
      }));

      // Sort by mtime descending (newest first)
      results.sort((a, b) => b.createdAt - a.createdAt);

      // Apply limit
      if (options?.limit && options.limit > 0) {
        const limited = results.slice(0, options.limit);
        logger.debug(`[codex-discovery] Found ${results.length} rollout files, returning ${limited.length} (limit: ${options.limit})`);
        return limited;
      }

      logger.debug(`[codex-discovery] Found ${results.length} rollout files`);
      return results;

    } catch (error) {
      logger.error('[codex-discovery] Failed to scan sessions directory:', error);
      return [];
    }
  }

  /**
   * Parse a Codex rollout JSONL file into ParsedSession format.
   *
   * Reads all records tolerantly, separates by type, extracts:
   * - session_meta (once) → identity, cwd, git
   * - turn_context (last one wins) → actual model
   * - response_item (function_call / function_call_output) → preserved in messages
   * - event_msg (user_message) → preserved in messages
   */
  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    try {
      const records = await readCodexJsonlTolerant<CodexRolloutRecord>(filePath);

      if (records.length === 0) {
        throw new ConfigurationError(`Rollout file is empty or unreadable: ${filePath}`);
      }

      // Separate records by type
      let sessionMeta: CodexSessionMeta | undefined;
      let lastTurnContext: CodexTurnContext | undefined;

      for (const record of records) {
        if (record.type === 'session_meta') {
          sessionMeta = record.payload as CodexSessionMeta;
        } else if (record.type === 'turn_context') {
          // Last turn_context wins (D-2)
          lastTurnContext = record.payload as CodexTurnContext;
        }
        // response_item and event_msg records are preserved in messages as-is
      }

      if (!sessionMeta) {
        throw new ConfigurationError(`No session_meta record found in rollout file: ${filePath}`);
      }

      // Validate session_meta.id (D-6: recordId uses this UUID)
      if (!sessionMeta.id || typeof sessionMeta.id !== 'string') {
        throw new ConfigurationError(`session_meta.id is missing or invalid in rollout file: ${filePath}`);
      }

      // Sanitize cwd before logging (security requirement)
      logger.debug('[codex-adapter] Parsing rollout file', ...sanitizeLogArgs({
        sessionMetaId: sessionMeta.id,
        recordCount: records.length,
      }));

      // Resolve model: turn_context.model (primary) → session_meta.model_provider (fallback) (D-2)
      const resolvedModel = lastTurnContext?.model?.trim() || sessionMeta.model_provider?.trim() || undefined;

      // Build ParsedSession
      const metadata = {
        projectPath: sessionMeta.cwd,
        createdAt: sessionMeta.timestamp,
        repository: sessionMeta.git?.repository_url,
        branch: sessionMeta.git?.branch,
        codexSessionId: sessionMeta.id,
        model: resolvedModel,
        cliVersion: sessionMeta.cli_version,
      };

      return {
        sessionId,
        agentName: 'Codex CLI',
        agentVersion: sessionMeta.cli_version,
        metadata,
        messages: records, // Preserved in full for processors
        metrics: {
          tools: {},
          toolStatus: {},
          fileOperations: [],
        },
      };

    } catch (error) {
      logger.error(`[codex-adapter] Failed to parse rollout file ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Process a Codex session file with all registered processors.
   */
  async processSession(
    filePath: string,
    sessionId: string,
    context: ProcessingContext
  ): Promise<AggregatedResult> {
    try {
      logger.debug(`[codex-adapter] Processing session ${sessionId} with ${this.processors.length} processors`);

      const parsedSession = await this.parseSessionFile(filePath, sessionId);

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
            logger.debug(`[codex-adapter] Processor ${processor.name} skipped`);
            continue;
          }

          logger.debug(`[codex-adapter] Running processor: ${processor.name}`);
          const result = await processor.process(parsedSession, context);

          processorResults[processor.name] = {
            success: result.success,
            message: result.message,
            recordsProcessed: result.metadata?.recordsProcessed as number | undefined,
          };

          if (!result.success) {
            failedProcessors.push(processor.name);
            logger.warn(`[codex-adapter] Processor ${processor.name} failed: ${result.message}`);
          }

          const recordsProcessed = result.metadata?.recordsProcessed as number | undefined;
          if (typeof recordsProcessed === 'number') {
            totalRecords += recordsProcessed;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[codex-adapter] Processor ${processor.name} threw:`, error);
          processorResults[processor.name] = { success: false, message: errorMessage };
          failedProcessors.push(processor.name);
        }
      }

      return {
        success: failedProcessors.length === 0,
        processors: processorResults,
        totalRecords,
        failedProcessors,
      };

    } catch (error) {
      logger.error('[codex-adapter] Session processing failed:', error);
      throw error;
    }
  }
}

/** Helper: return true if path is a directory */
async function isDirectory(p: string): Promise<boolean> {
  if (!existsSync(p)) return false;
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
