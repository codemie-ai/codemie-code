/**
 * Session Correlator
 *
 * Correlates CodeMie sessions with agent session files.
 * Uses before/after snapshot diff + working directory filtering.
 */

import { readFile } from 'fs/promises';
import type { FileInfo, CorrelationResult, AgentMetricsSupport } from '../types.js';
import { logger } from '../../../../utils/logger.js';
import { METRICS_CONFIG } from '../../metrics-config.js';

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

    logger.info(`[SessionCorrelator] Analyzing ${newFiles.length} candidate file${newFiles.length !== 1 ? 's' : ''}...`);

    // Show candidate files at INFO level for debugging
    if (newFiles.length > 0) {
      logger.info(`[SessionCorrelator] Candidate files:`);
      const sampleSize = Math.min(5, newFiles.length);
      for (let i = 0; i < sampleSize; i++) {
        logger.info(`[SessionCorrelator]    ${i + 1}. ${newFiles[i].path}`);
      }
      if (newFiles.length > sampleSize) {
        logger.info(`[SessionCorrelator]    ... and ${newFiles.length - sampleSize} more`);
      }
    }

    // Case 1: No new files
    if (newFiles.length === 0) {
      logger.warn('[SessionCorrelator] No session files detected - will retry');
      return {
        status: 'pending',
        retryCount: 0
      };
    }

    // Case 2: Filter files by agent pattern
    logger.info(`[SessionCorrelator] Step 1: Filtering by agent session pattern...`);
    const matchingFiles = newFiles.filter(f =>
      agentPlugin.matchesSessionPattern(f.path)
    );

    if (matchingFiles.length > 0) {
      logger.info(`[SessionCorrelator] ${matchingFiles.length} file${matchingFiles.length !== 1 ? 's' : ''} match${matchingFiles.length === 1 ? 'es' : ''} pattern`);
      // Use path.basename for cross-platform display
      const { basename } = await import('path');
      logger.info(`[SessionCorrelator]    ${matchingFiles.map(f => `→ ${basename(f.path)}`).join(', ')}`);
    }
    logger.debug(`[SessionCorrelator] Pattern matching: ${matchingFiles.length}/${newFiles.length} files passed`);

    // Show which files were filtered out and why
    if (matchingFiles.length < newFiles.length) {
      const filtered = newFiles.filter(f => !matchingFiles.includes(f));
      logger.debug(`[SessionCorrelator] Filtered out ${filtered.length} files (pattern mismatch): ${filtered.map(f => f.path).join(', ')}`);
    }

    if (matchingFiles.length === 0) {
      logger.warn('[SessionCorrelator] No session files match expected pattern - correlation failed');
      logger.info(`[SessionCorrelator]    Agent: ${input.agentName}`);
      logger.info(`[SessionCorrelator]    Working directory: ${workingDirectory}`);

      // Show why files were rejected
      if (newFiles.length > 0) {
        logger.info(`[SessionCorrelator]    None of the ${newFiles.length} candidate files matched the pattern`);
        // Test first file and explain why it failed
        const testFile = newFiles[0].path;
        logger.debug(`[SessionCorrelator]    Testing pattern on: ${testFile}`);
        logger.debug(`[SessionCorrelator]    matchesSessionPattern() returned: ${agentPlugin.matchesSessionPattern(testFile)}`);
      }

      return {
        status: 'failed',
        retryCount: 0
      };
    }

    // Case 3: Filter by working directory (parse file content)
    logger.info(`[SessionCorrelator] Step 2: Checking working directory match...`);
    logger.debug(`[SessionCorrelator] Working directory: ${workingDirectory}`);
    const filesWithWorkingDir = await this.filterByWorkingDirectory(
      matchingFiles,
      workingDirectory
    );

    if (filesWithWorkingDir.length > 0) {
      logger.info(`[SessionCorrelator] ${filesWithWorkingDir.length} file${filesWithWorkingDir.length !== 1 ? 's' : ''} contain${filesWithWorkingDir.length === 1 ? 's' : ''} working directory`);
    } else {
      logger.info(`[SessionCorrelator] No files contain working directory - using first pattern match`);
    }
    logger.debug(`[SessionCorrelator] Working directory matches: ${filesWithWorkingDir.length}/${matchingFiles.length} files`);

    // Pick first match (simple strategy)
    const matchedFile = filesWithWorkingDir.length > 0
      ? filesWithWorkingDir[0]
      : matchingFiles[0]; // Fallback to first pattern match if no working dir match

    // Extract session ID
    const agentSessionId = agentPlugin.extractSessionId(matchedFile.path);

    logger.info(`[SessionCorrelator] Session matched: ${agentSessionId}`);
    logger.info(`[SessionCorrelator]    Session file: ${matchedFile.path}`);

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

      logger.info(`[SessionCorrelator] Retry ${attempt + 1}/${METRICS_CONFIG.retry.attempts} after ${delay}ms...`);
      logger.debug(`[SessionCorrelator] Waiting ${delay}ms before retry ${attempt + 1}`);

      await this.sleep(delay);

      // Take new snapshot
      logger.debug(`[SessionCorrelator] Taking new snapshot for retry ${attempt + 1}`);
      const newFiles = await snapshotFn();

      // Retry correlation
      result = await this.correlate({
        ...input,
        newFiles
      });

      result.retryCount = attempt + 1;

      if (result.status === 'matched') {
        logger.info(`[SessionCorrelator] Session matched on retry ${attempt + 1}`);
        return result;
      }
    }

    // All retries exhausted
    logger.warn(`[SessionCorrelator] ❌ Session matching failed after ${METRICS_CONFIG.retry.attempts} attempts - metrics collection disabled`);
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
