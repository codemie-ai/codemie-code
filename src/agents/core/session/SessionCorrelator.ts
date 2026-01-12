/**
 * Session Correlator
 *
 * Correlates CodeMie sessions with agent session files.
 * Uses before/after snapshot diff + working directory filtering.
 */

import { readFile } from 'fs/promises';
import type { FileInfo, CorrelationResult } from './types.js';
import type { AgentMetricsSupport } from '../metrics/types.js';
import { logger } from '../../../utils/logger.js';
import { METRICS_CONFIG } from '../metrics-config.js';

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
    const { newFiles, agentPlugin, workingDirectory, agentName } = input;

    logger.debug(`[SessionCorrelator] correlate: candidates=${newFiles.length} agent=${agentName} cwd=${workingDirectory}`);

    // Case 1: No new files
    if (newFiles.length === 0) {
      logger.warn('[SessionCorrelator] correlate: status=pending reason=no_files');
      return {
        status: 'pending',
        retryCount: 0
      };
    }

    // Case 2: Filter files by agent pattern
    const matchingFiles = newFiles.filter(f =>
      agentPlugin.matchesSessionPattern(f.path)
    );

    logger.debug(`[SessionCorrelator] pattern_filter: total=${newFiles.length} matched=${matchingFiles.length}`);

    if (matchingFiles.length === 0) {
      logger.warn(`[SessionCorrelator] correlate: status=failed reason=no_pattern_matches agent=${agentName}`);
      return {
        status: 'failed',
        retryCount: 0
      };
    }

    // Tier 1: Single file fast path (no content check needed)
    if (matchingFiles.length === 1) {
      const matchedFile = matchingFiles[0];
      const agentSessionId = agentPlugin.extractSessionId(matchedFile.path);

      logger.info(`[SessionCorrelator] correlate: status=matched strategy=fast_path session_id=${agentSessionId} file=${matchedFile.path}`);

      return {
        status: 'matched',
        agentSessionFile: matchedFile.path,
        agentSessionId,
        detectedAt: Date.now(),
        retryCount: 0
      };
    }

    // Tier 2: Multiple files - filter by working directory (partial content check)
    const filesWithWorkingDir = await this.filterByWorkingDirectory(
      matchingFiles,
      workingDirectory
    );

    logger.debug(`[SessionCorrelator] workdir_filter: total=${matchingFiles.length} matched=${filesWithWorkingDir.length}`);

    // Pick first match (simple strategy)
    const matchedFile = filesWithWorkingDir.length > 0
      ? filesWithWorkingDir[0]
      : matchingFiles[0]; // Fallback to first pattern match if no working dir match

    // Extract session ID
    const agentSessionId = agentPlugin.extractSessionId(matchedFile.path);
    const strategy = filesWithWorkingDir.length > 0 ? 'workdir_match' : 'pattern_fallback';

    logger.info(`[SessionCorrelator] correlate: status=matched strategy=${strategy} session_id=${agentSessionId} file=${matchedFile.path}`);

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

      logger.debug(`[SessionCorrelator] retry: attempt=${attempt + 1}/${METRICS_CONFIG.retry.attempts} delay=${delay}ms`);

      await this.sleep(delay);

      // Take new snapshot and retry correlation
      const newFiles = await snapshotFn();
      result = await this.correlate({
        ...input,
        newFiles
      });

      result.retryCount = attempt + 1;

      if (result.status === 'matched') {
        logger.info(`[SessionCorrelator] correlate: status=matched retry=${attempt + 1}`);
        return result;
      }
    }

    // All retries exhausted
    logger.warn(`[SessionCorrelator] correlate: status=failed reason=retries_exhausted attempts=${METRICS_CONFIG.retry.attempts}`);
    result.status = 'failed';
    return result;
  }

  /**
   * Filter files by working directory content
   * Optimized to read only first 10 + last 10 lines instead of entire file
   */
  private async filterByWorkingDirectory(
    files: FileInfo[],
    workingDirectory: string
  ): Promise<FileInfo[]> {
    const filtered: FileInfo[] = [];

    for (const file of files) {
      try {
        const hasMatch = await this.checkWorkingDirectoryInLines(file.path, workingDirectory);
        if (hasMatch) {
          filtered.push(file);
        }
      } catch (error) {
        logger.debug(`[SessionCorrelator] read_error: file=${file.path}`, error);
      }
    }

    return filtered;
  }

  /**
   * Check if working directory appears in first 10 or last 10 lines
   * This optimization avoids reading entire files (which can be 37KB+)
   * Working directory typically appears in:
   *   - First lines: Session metadata (most common)
   *   - Last lines: Final conversation turns (edge case)
   */
  private async checkWorkingDirectoryInLines(
    filePath: string,
    workingDirectory: string
  ): Promise<boolean> {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    // Check first 10 lines (session metadata - most common location)
    const head = lines.slice(0, 10).join('\n');
    if (head.includes(workingDirectory)) {
      return true;
    }

    // Check last 10 lines (edge case: working directory in final conversation turn)
    const tail = lines.slice(-10).join('\n');
    return tail.includes(workingDirectory);
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
