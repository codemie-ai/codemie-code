/**
 * Local JSONL writer for analytics
 * Writes events to daily log files in JSONL format
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AnalyticsEvent, IAnalyticsWriter } from './types.js';

/**
 * Writes analytics events to local JSONL files
 * One file per day: ~/.codemie/analytics/YYYY-MM-DD.jsonl
 */
export class AnalyticsWriter implements IAnalyticsWriter {
  private basePath: string;

  constructor(basePath?: string) {
    // Expand ~ to home directory
    this.basePath = basePath
      ? basePath.replace(/^~/, homedir())
      : join(homedir(), '.codemie', 'analytics');
  }

  /**
   * Write events to daily log file
   */
  async write(events: AnalyticsEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    try {
      // Get current date for filename
      const date = new Date().toISOString().split('T')[0];
      const filePath = join(this.basePath, `${date}.jsonl`);

      // Ensure directory exists
      await mkdir(this.basePath, { recursive: true });

      // Convert events to JSONL (one JSON per line)
      const lines = events.map((event) => JSON.stringify(event)).join('\n') + '\n';

      // Append to file (non-blocking)
      await appendFile(filePath, lines, 'utf-8');
    } catch (error) {
      // Silently fail - don't block agent execution
      console.error('Analytics write error:', error);
    }
  }
}
