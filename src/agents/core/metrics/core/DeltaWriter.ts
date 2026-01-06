/**
 * Delta Writer
 *
 * Handles incremental metrics storage in JSONL format.
 * Stores metrics in: ~/.codemie/metrics/sessions/{sessionId}_metrics.jsonl
 * Provides O(1) append operations and efficient filtering by sync status.
 */

import { appendFile, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { MetricDelta, SyncStatus } from '../types.js';
import { logger } from '../../../../utils/logger.js';
import { getSessionMetricsPath } from '../../metrics-config.js';
import { createErrorContext, formatErrorForLog } from '../../../../utils/errors.js';

export class DeltaWriter {
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

      logger.debug(`[DeltaWriter] Appended delta: ${delta.recordId}`);
      return delta.recordId;

    } catch (error) {
      const errorContext = createErrorContext(error);
      logger.error('[DeltaWriter] Failed to append delta', formatErrorForLog(errorContext));
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
      logger.error('[DeltaWriter] Failed to read deltas', formatErrorForLog(errorContext));
      throw error;
    }
  }

  /**
   * Update sync status for specific records
   * This requires rewriting the entire file
   */
  async updateSyncStatus(
    recordIds: string[],
    status: SyncStatus,
    error?: string
  ): Promise<void> {
    try {
      // Read all deltas
      const deltas = await this.readAll();

      // Update matching records
      const recordIdSet = new Set(recordIds);
      const updatedDeltas = deltas.map(delta => {
        if (recordIdSet.has(delta.recordId)) {
          return {
            ...delta,
            syncStatus: status,
            syncedAt: status === 'synced' ? Date.now() : delta.syncedAt,
            syncAttempts: delta.syncAttempts + 1,
            syncError: error
          };
        }
        return delta;
      });

      // Rewrite file
      const content = updatedDeltas
        .map(delta => JSON.stringify(delta))
        .join('\n') + '\n';

      await writeFile(this.filePath, content, 'utf-8');

      logger.debug(`[DeltaWriter] Updated sync status for ${recordIds.length} records to: ${status}`);

    } catch (error) {
      const errorContext = createErrorContext(error);
      logger.error('[DeltaWriter] Failed to update sync status', formatErrorForLog(errorContext));
      throw error;
    }
  }

  /**
   * Get deltas with specific sync status
   */
  async filterByStatus(status: SyncStatus): Promise<MetricDelta[]> {
    try {
      const allDeltas = await this.readAll();
      return allDeltas.filter(delta => delta.syncStatus === status);

    } catch (error) {
      const errorContext = createErrorContext(error);
      logger.error(`[DeltaWriter] Failed to filter by status ${status}`, formatErrorForLog(errorContext));
      throw error;
    }
  }

  /**
   * Get sync statistics
   */
  async getSyncStats(): Promise<{
    total: number;
    pending: number;
    syncing: number;
    synced: number;
    failed: number;
  }> {
    try {
      const deltas = await this.readAll();

      const stats = {
        total: deltas.length,
        pending: 0,
        syncing: 0,
        synced: 0,
        failed: 0
      };

      for (const delta of deltas) {
        stats[delta.syncStatus]++;
      }

      return stats;

    } catch (error) {
      const errorContext = createErrorContext(error);
      logger.error('[DeltaWriter] Failed to get sync stats', formatErrorForLog(errorContext));
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
