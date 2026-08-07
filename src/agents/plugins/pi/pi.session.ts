/**
 * Pi Session Adapter
 *
 * Discovers and parses Pi JSONL session files, then runs the metrics processor.
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import type { SessionAdapter, ParsedSession, AggregatedResult, SessionDiscoveryOptions, SessionDescriptor } from '../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext } from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { getPiSessionDir } from './pi.paths.js';
import { PiMetricsProcessor } from './session/processors/pi.metrics-processor.js';
import { isPiSessionHeader, type PiEntry, type PiSessionHeader } from './pi.types.js';

export class PiSessionAdapter implements SessionAdapter {
  readonly agentName = 'pi';
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    this.initializeProcessors();
  }

  private initializeProcessors(): void {
    this.registerProcessor(new PiMetricsProcessor());
    logger.debug(`[pi-adapter] Initialized ${this.processors.length} processors`);
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[pi-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
  }

  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    try {
      const entries = await this.readJsonlFile(filePath);
      const header = await this.readSessionHeader(filePath);
      const projectPath = header?.cwd ?? process.cwd();

      return {
        sessionId,
        agentName: this.metadata.displayName || 'Pi',
        metadata: {
          projectPath,
          ...(header?.timestamp && { createdAt: header.timestamp }),
        },
        messages: entries as unknown[],
      };
    } catch (error) {
      logger.error(`[pi-adapter] Failed to parse session file ${filePath}:`, error);
      throw error;
    }
  }

  private async readSessionHeader(filePath: string): Promise<PiSessionHeader | undefined> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const firstLine = content.split('\n')[0]?.trim();
      if (!firstLine) return undefined;
      const parsed = JSON.parse(firstLine);
      if (isPiSessionHeader(parsed)) {
        return parsed;
      }
    } catch {
      // ignore — malformed header is handled by caller
    }
    return undefined;
  }

  private async readJsonlFile(filePath: string): Promise<PiEntry[]> {
    const content = await readFile(filePath, 'utf-8');
    const entries: PiEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          entries.push(parsed as PiEntry);
        } else {
          logger.debug(`[pi-adapter] Skipping non-object JSONL line in ${filePath}`);
        }
      } catch {
        logger.debug(`[pi-adapter] Skipping malformed JSONL line in ${filePath}`);
      }
    }
    return entries;
  }

  async processSession(filePath: string, sessionId: string, context: ProcessingContext): Promise<AggregatedResult> {
    const parsedSession = await this.parseSessionFile(filePath, sessionId);
    if (context.gitBranch && parsedSession.metadata) {
      (parsedSession.metadata as Record<string, unknown>).gitBranch = context.gitBranch;
    }

    const processorResults: Record<string, { success: boolean; message?: string; recordsProcessed?: number }> = {};
    const failedProcessors: string[] = [];
    let totalRecords = 0;

    for (const processor of this.processors) {
      try {
        if (!processor.shouldProcess(parsedSession)) {
          logger.debug(`[pi-adapter] Processor ${processor.name} skipped`);
          continue;
        }
        const result = await processor.process(parsedSession, context);
        processorResults[processor.name] = {
          success: result.success,
          message: result.message,
          recordsProcessed: result.metadata?.recordsProcessed,
        };
        if (!result.success) {
          failedProcessors.push(processor.name);
        }
        if (typeof result.metadata?.recordsProcessed === 'number') {
          totalRecords += result.metadata.recordsProcessed;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[pi-adapter] Processor ${processor.name} threw:`, error);
        processorResults[processor.name] = { success: false, message: msg };
        failedProcessors.push(processor.name);
      }
    }

    return {
      success: failedProcessors.length === 0,
      processors: processorResults,
      totalRecords,
      failedProcessors,
    };
  }

  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    const cwd = options?.cwd ?? process.cwd();
    const sessionDir = getPiSessionDir(cwd);

    const maxAgeDays = options?.maxAgeDays ?? 30;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    const results = await this.scanSessionDir(sessionDir, cutoff, cwd);
    results.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    const limited = options?.limit && options.limit > 0 ? results.slice(0, options.limit) : results;
    logger.debug(`[pi-discovery] Found ${results.length} Pi sessions, returning ${limited.length}`);
    return limited;
  }

  private async scanSessionDir(sessionDir: string, cutoff: number, projectPath: string): Promise<SessionDescriptor[]> {
    if (!existsSync(sessionDir)) {
      return [];
    }

    const resolvedCwd = resolve(projectPath);
    const results: SessionDescriptor[] = [];
    try {
      const files = await readdir(sessionDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = join(sessionDir, file);

        let statResult;
        try {
          statResult = await stat(filePath);
        } catch {
          continue;
        }
        if (!statResult.isFile()) continue;

        // Filter on modification time so long-running sessions are not discarded
        // while they are still being written to.
        const updatedAt = statResult.mtime.getTime();
        if (updatedAt < cutoff) continue;

        const header = await this.readSessionHeader(filePath);
        if (!header) {
          logger.debug(`[pi-discovery] Skipping file with invalid header: ${filePath}`);
          continue;
        }

        // Only attribute sessions whose own header claims this cwd.
        if (resolve(header.cwd) !== resolvedCwd) {
          logger.debug(`[pi-discovery] Skipping session from different cwd: ${header.cwd}`);
          continue;
        }

        const createdAt = Date.parse(header.timestamp);
        results.push({
          sessionId: header.id,
          filePath,
          projectPath: header.cwd,
          createdAt: Number.isNaN(createdAt) ? updatedAt : createdAt,
          updatedAt,
          agentName: 'pi',
        });
      }
    } catch (error) {
      logger.debug(`[pi-discovery] Failed to scan session dir ${sessionDir}:`, error);
    }

    return results;
  }
}
