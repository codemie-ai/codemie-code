/**
 * Session Correlator
 *
 * Correlates CodeMie sessions with agent session files.
 * Uses before/after snapshot diff + working directory filtering.
 */

import { readFile } from 'fs/promises';
import type { FileInfo, CorrelationResult, AgentMetricsSupport } from '../types.js';
import { logger } from '../../utils/logger.js';
import { METRICS_CONFIG } from '../config.js';

export interface CorrelationInput {
  sessionId: string;
  agentName: string;
  workingDirectory: string;
  newFiles: FileInfo[];
  agentPlugin: AgentMetricsSupport;
}

export class SessionCorrelator {
  /**
   * Correlate CodeMie session to agent session file
   * Picks first match after filtering by working directory
   */
  async correlate(input: CorrelationInput): Promise<CorrelationResult> {
    const { newFiles, agentPlugin, workingDirectory } = input;

    logger.debug(`[SessionCorrelator] Correlating session with ${newFiles.length} new files`);

    // Case 1: No new files
    if (newFiles.length === 0) {
      logger.debug('[SessionCorrelator] No new files detected');
      return {
        status: 'pending',
        retryCount: 0
      };
    }

    // Case 2: Filter files by agent pattern
    const matchingFiles = newFiles.filter(f =>
      agentPlugin.matchesSessionPattern(f.path)
    );

    logger.debug(`[SessionCorrelator] ${matchingFiles.length} files match agent pattern`);

    if (matchingFiles.length === 0) {
      logger.warn('[SessionCorrelator] No files match agent pattern');
      return {
        status: 'failed',
        retryCount: 0
      };
    }

    // Case 3: Filter by working directory (parse file content)
    const filesWithWorkingDir = await this.filterByWorkingDirectory(
      matchingFiles,
      workingDirectory
    );

    logger.debug(`[SessionCorrelator] ${filesWithWorkingDir.length} files contain working directory`);

    // Pick first match (simple strategy)
    const matchedFile = filesWithWorkingDir.length > 0
      ? filesWithWorkingDir[0]
      : matchingFiles[0]; // Fallback to first pattern match if no working dir match

    // Extract session ID
    const agentSessionId = agentPlugin.extractSessionId(matchedFile.path);

    logger.info(`[SessionCorrelator] Matched: ${matchedFile.path} → ${agentSessionId}`);

    return {
      status: 'matched',
      agentSessionFile: matchedFile.path,
      agentSessionId,
      detectedAt: Date.now(),
      retryCount: 0
    };
  }

  /**
   * Retry correlation with exponential backoff
   */
  async correlateWithRetry(
    input: CorrelationInput,
    snapshotFn: () => Promise<FileInfo[]>
  ): Promise<CorrelationResult> {
    let result = await this.correlate(input);

    // If matched on first try, return immediately
    if (result.status === 'matched') {
      return result;
    }

    // Retry with exponential backoff
    for (let attempt = 0; attempt < METRICS_CONFIG.retry.attempts; attempt++) {
      const delay = METRICS_CONFIG.retry.delays[attempt];

      logger.debug(`[SessionCorrelator] Retry attempt ${attempt + 1} after ${delay}ms`);

      await this.sleep(delay);

      // Take new snapshot
      const newFiles = await snapshotFn();

      // Retry correlation
      result = await this.correlate({
        ...input,
        newFiles
      });

      result.retryCount = attempt + 1;

      if (result.status === 'matched') {
        logger.info(`[SessionCorrelator] Matched on retry attempt ${attempt + 1}`);
        return result;
      }
    }

    // All retries exhausted
    logger.warn(`[SessionCorrelator] Failed to correlate after ${METRICS_CONFIG.retry.attempts} attempts`);
    result.status = 'failed';
    return result;
  }

  /**
   * Filter files by working directory content
   */
  private async filterByWorkingDirectory(
    files: FileInfo[],
    workingDirectory: string
  ): Promise<FileInfo[]> {
    const filtered: FileInfo[] = [];

    for (const file of files) {
      try {
        const content = await readFile(file.path, 'utf-8');

        // Check if file content contains working directory path
        if (content.includes(workingDirectory)) {
          filtered.push(file);
        }
      } catch (error) {
        // Skip files that can't be read
        logger.debug(`[SessionCorrelator] Failed to read file: ${file.path}`, error);
      }
    }

    return filtered;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
