/**
 * Metrics Writer
 *
 * Handles incremental metrics storage in JSONL format.
 * Stores metrics in: ~/.codemie/sessions/{sessionId}_metrics.jsonl
 * Provides O(1) append operations and efficient filtering by sync status.
 */

import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { MetricDelta } from '../../../../../../agents/core/metrics/types.js';
import { logger } from '../../../../../../utils/logger.js';
import { getSessionMetricsPath } from '../../../../../../agents/core/session/session-config.js';
import { createErrorContext, formatErrorForLog } from '../../../../../../utils/errors.js';

export class MetricsWriter {
  private readonly filePath: string;

  constructor(sessionId: string) {
    this.filePath = getSessionMetricsPath(sessionId);
  }

  /**
   * Append new delta to JSONL file (O(1) operation)
   * Returns the recordId from the delta
   */
  async appendDelta(
    delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>
  ): Promise<string> {
    try {
      // Ensure directory exists
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      // Create full delta record (recordId already set from message UUID)
      const fullDelta: MetricDelta = {
        ...delta,
        syncStatus: 'pending',
        syncAttempts: 0
      };

      // Append to JSONL
      const line = JSON.stringify(fullDelta) + '\n';
      await appendFile(this.filePath, line, 'utf-8');

      logger.debug(`[MetricsWriter] Appended delta: ${delta.recordId}`);
      return delta.recordId;

    } catch (error) {
      const errorContext = createErrorContext(error);
      logger.error('[MetricsWriter] Failed to append delta', formatErrorForLog(errorContext));
      throw error;
    }
  }

  /**
   * Read all deltas from JSONL file
   */
  async readAll(): Promise<MetricDelta[]> {
    try {
      if (!existsSync(this.filePath)) {
        return [];
      }

      const content = await readFile(this.filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);

      return lines.map(line => JSON.parse(line) as MetricDelta);

    } catch (error) {
      const errorContext = createErrorContext(error);
      logger.error('[MetricsWriter] Failed to read deltas', formatErrorForLog(errorContext));
      throw error;
    }
  }
    /**
     * Get file path
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Check if file exists
   */
  exists(): boolean {
    return existsSync(this.filePath);
  }
}
