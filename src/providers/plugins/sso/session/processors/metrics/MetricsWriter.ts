/**
 * Metrics Writer
 *
 * Handles incremental metrics storage in JSONL format.
 * Stores metrics in: ~/.codemie/sessions/{sessionId}_metrics.jsonl
 * Appends a batch of deltas under the file lock: reads the file to collect the recordIds already
 * written (dedupe), then writes the batch in one append. Also filters by sync status.
 */

import { appendFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { MetricDelta } from '../../../../../../agents/core/metrics/types.js';
import { logger } from '../../../../../../utils/logger.js';
import { getSessionMetricsPath } from '../../../../../../agents/core/session/session-config.js';
import { withSessionFile, type LockBounds } from '../../utils/locked-jsonl.js';
import { createErrorContext, formatErrorForLog } from '../../../../../../utils/errors.js';

/** The record's own slice of a shared transcript: [`startTime`, `upperBound`), plus what stops the lock wait. */
export interface RunWindow extends LockBounds {
  startTime: number;
  upperBound?: number;
}

export interface AppendResult {
  written: number;
  dup: number;
  beforeStart: number;
  afterEnd: number;
}

function parseDeltaTime(timestamp: number | string): number | undefined {
  const time = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  return Number.isFinite(time) ? time : undefined;
}

export class MetricsWriter {
  private readonly filePath: string;

  constructor(private readonly sessionId: string) {
    this.filePath = getSessionMetricsPath(sessionId);
  }

  /**
   * Append a batch of deltas under the metrics lock: one read, one append.
   *
   * Dropped: a delta whose `recordId` is already in the file (or earlier in the batch), one older than
   * the record's `startTime`, one at or after `upperBound` (the next record's start over the same
   * transcript). A time that is not a finite number (or an ISO string) is never judged. A lock that stays
   * held throws and writes nothing; a file already completed and renamed is not re-created.
   */
  async appendDeltas(
    deltas: Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>>,
    window: RunWindow
  ): Promise<AppendResult> {
    const result: AppendResult = { written: 0, dup: 0, beforeStart: 0, afterEnd: 0 };
    try {
      await withSessionFile('metrics', this.sessionId, window, false, async () => {
        const known = await this.readRecordIds();
        const lines: string[] = [];
        for (const delta of deltas) {
          if (known.has(delta.recordId)) {
            result.dup++;
            continue;
          }
          const time = parseDeltaTime(delta.timestamp);
          if (time !== undefined && time < window.startTime) {
            result.beforeStart++;
            continue;
          }
          if (time !== undefined && window.upperBound !== undefined && time >= window.upperBound) {
            result.afterEnd++;
            continue;
          }
          known.add(delta.recordId);
          const full: MetricDelta = { ...delta, syncStatus: 'pending', syncAttempts: 0 };
          lines.push(JSON.stringify(full) + '\n');
        }
        if (lines.length > 0) {
          await appendFile(this.filePath, lines.join(''), 'utf-8');
        }
        result.written = lines.length;
      });
      logger.debug(
        `[MetricsWriter] in=${deltas.length} dup=${result.dup} before_start=${result.beforeStart} ` +
        `after_end=${result.afterEnd} written=${result.written}`
      );
      return result;
    } catch (error) {
      const errorContext = createErrorContext(error);
      logger.error('[MetricsWriter] Failed to append deltas', formatErrorForLog(errorContext));
      throw error;
    }
  }

  /** The recordIds on disk; a malformed line (a torn append) is skipped, not fatal. */
  private async readRecordIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    if (!existsSync(this.filePath)) return ids;
    for (const line of (await readFile(this.filePath, 'utf-8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        ids.add((JSON.parse(line) as MetricDelta).recordId);
      } catch {
        logger.debug('[MetricsWriter] Skipping malformed delta line while reading record ids');
      }
    }
    return ids;
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
