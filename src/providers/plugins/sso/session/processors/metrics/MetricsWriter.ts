/**
 * Metrics Writer
 *
 * Handles incremental metrics storage in JSONL format.
 * Stores metrics in: ~/.codemie/sessions/{sessionId}_metrics.jsonl
 * Appends a batch of deltas under the file lock: reads the file to collect the recordIds already
 * written (dedupe), then writes the batch in one append. Also filters by sync status.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { MetricDelta } from '../../../../../../agents/core/metrics/types.js';
import { logger } from '../../../../../../utils/logger.js';
import { getSessionMetricsPath } from '../../../../../../agents/core/session/session-config.js';
import { appendJsonlLines, withSessionFile, type LockBounds } from '../../utils/locked-jsonl.js';
import { createErrorContext, formatErrorForLog } from '../../../../../../utils/errors.js';
import { deltaIdOf } from './delta-id.js';
import { readJSONLTolerant } from '@/agents/core/session/utils/jsonl-reader.js';

/** The record's own slice of a shared transcript: [`startTime`, `upperBound`), plus what stops the lock wait. */
export interface RunWindow extends LockBounds {
  startTime: number;
  upperBound?: number;
}

export interface AppendResult {
  /** Deltas appended to the file */
  written: number;
  /** The live file is gone (the session was completed and renamed): nothing appended */
  gone: boolean;
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
   * held throws and writes nothing; a file already completed and renamed is not re-created (`gone`).
   * @throws {SessionFileLockTimeoutError} When the metrics lock stays held past the window's bounds
   */
  async appendDeltas(
    deltas: Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>>,
    window: RunWindow
  ): Promise<AppendResult> {
    const result: AppendResult = { written: 0, gone: false, dup: 0, beforeStart: 0, afterEnd: 0 };
    try {
      const done = await withSessionFile('metrics', this.sessionId, window, false, async () => {
        const known = await this.readRecordIds();
        const accepted: Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> = [];
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
          accepted.push(delta);
        }
        // One id for the batch, made once here and never recomputed
        const deltaId = deltaIdOf(accepted.map(d => d.recordId));
        const lines = accepted.map(d => {
          const full: MetricDelta = { ...d, syncStatus: 'pending', syncAttempts: 0, deltaId };
          return JSON.stringify(full) + '\n';
        });
        if (lines.length > 0) {
          await appendJsonlLines(this.filePath, lines.join(''));
        }
        result.written = lines.length;
        return true;
      });
      result.gone = done !== true;
      logger.debug(
        `[MetricsWriter] in=${deltas.length} dup=${result.dup} before_start=${result.beforeStart} ` +
        `after_end=${result.afterEnd} written=${result.written} gone=${result.gone}`
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
   * Read all deltas from JSONL file; a torn line is skipped with a warn
   */
  async readAll(): Promise<MetricDelta[]> {
    try {
      return await readJSONLTolerant<MetricDelta>(this.filePath, '[MetricsWriter]');
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
