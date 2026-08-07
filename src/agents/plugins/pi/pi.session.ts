/**
 * Pi Session Adapter
 *
 * Discovers and parses Pi JSONL session files, then runs the metrics processor.
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { SessionAdapter, ParsedSession, AggregatedResult, SessionDiscoveryOptions, SessionDescriptor } from '../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext } from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { getPiAgentDir, getPiSessionDir } from './pi.paths.js';
import { PiMetricsProcessor } from './session/processors/pi.metrics-processor.js';
import type { PiEntry } from './pi.types.js';

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
      const projectPath = process.cwd();

      return {
        sessionId,
        agentName: this.metadata.displayName || 'Pi',
        metadata: { projectPath },
        messages: entries as unknown[],
      };
    } catch (error) {
      logger.error(`[pi-adapter] Failed to parse session file ${filePath}:`, error);
      throw error;
    }
  }

  private async readJsonlFile(filePath: string): Promise<PiEntry[]> {
    const content = await readFile(filePath, 'utf-8');
    const entries: PiEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as PiEntry);
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
    const exactSessionDir = getPiSessionDir(cwd);
    const baseSessionsDir = join(getPiAgentDir(cwd), 'sessions');

    const maxAgeDays = options?.maxAgeDays ?? 30;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    const exactResults = await this.scanSessionDir(exactSessionDir, cutoff, cwd);

    // Defensive fallback: if the exact cwd-encoded directory is empty or missing,
    // scan sibling session directories so a Pi encoding change does not silently
    // drop metrics.
    let fallbackResults: SessionDescriptor[] = [];
    if (exactResults.length === 0 && existsSync(baseSessionsDir)) {
      try {
        const siblings = await readdir(baseSessionsDir);
        for (const sibling of siblings) {
          const siblingDir = join(baseSessionsDir, sibling);
          const siblingStat = await stat(siblingDir);
          if (!siblingStat.isDirectory()) continue;
          const siblingResults = await this.scanSessionDir(siblingDir, cutoff, cwd);
          fallbackResults.push(...siblingResults);
        }
      } catch (error) {
        logger.debug(`[pi-discovery] Failed to scan fallback session dirs:`, error);
      }
    }

    const results = exactResults.length > 0 ? exactResults : fallbackResults;
    results.sort((a, b) => b.createdAt - a.createdAt);

    const limited = options?.limit && options.limit > 0 ? results.slice(0, options.limit) : results;
    logger.debug(`[pi-discovery] Found ${results.length} Pi sessions, returning ${limited.length}`);
    return limited;
  }

  private async scanSessionDir(sessionDir: string, cutoff: number, projectPath: string): Promise<SessionDescriptor[]> {
    if (!existsSync(sessionDir)) {
      return [];
    }

    const results: SessionDescriptor[] = [];
    try {
      const files = await readdir(sessionDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = join(sessionDir, file);
        const statResult = await stat(filePath);
        if (!statResult.isFile()) continue;

        const match = file.match(/^(\d+)_(.+?)\.jsonl$/);
        if (!match) continue;
        const createdAt = parseInt(match[1], 10);
        const sessionId = match[2];
        if (Number.isNaN(createdAt) || createdAt < cutoff) continue;

        results.push({
          sessionId,
          filePath,
          projectPath,
          createdAt,
          updatedAt: statResult.mtime.getTime(),
          agentName: 'pi',
        });
      }
    } catch (error) {
      logger.debug(`[pi-discovery] Failed to scan session dir ${sessionDir}:`, error);
    }

    return results;
  }
}
