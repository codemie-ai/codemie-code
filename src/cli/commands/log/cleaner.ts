/**
 * Log cleaner - Cleanup old logs and sessions
 */

import { readdirSync, statSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { getCodemiePath } from '../../../utils/paths.js';
import type { CleanupStats } from './types.js';

/**
 * Clean up old log files and sessions
 */
export class LogCleaner {
  private logsDir: string;
  private sessionsDir: string;

  constructor(logsDir?: string, sessionsDir?: string) {
    this.logsDir = logsDir || getCodemiePath('logs');
    this.sessionsDir = sessionsDir || getCodemiePath('sessions');
  }

  /**
   * Clean old files
   */
  clean(retentionDays: number, includeSessions: boolean, dryRun: boolean): CleanupStats {
    const stats: CleanupStats = {
      debugLogsDeleted: 0,
      sessionsDeleted: 0,
      bytesFreed: 0
    };

    const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

    // Clean debug logs
    this.cleanDebugLogs(cutoffTime, dryRun, stats);

    // Clean sessions if requested
    if (includeSessions) {
      this.cleanSessions(cutoffTime, dryRun, stats);
    }

    return stats;
  }

  /**
   * Clean debug log files
   *
   * Note: We use file modification time (mtimeMs) rather than filename dates
   * because it's more reliable for cleanup (handles manual edits, moved files, etc.)
   * The reader uses filename dates for filtering, which is appropriate for its use case.
   */
  private cleanDebugLogs(cutoffTime: number, dryRun: boolean, stats: CleanupStats): void {
    try {
      if (!existsSync(this.logsDir)) {
        return;
      }

      const files = readdirSync(this.logsDir);

      for (const file of files) {
        // Only process debug log files
        if (!file.match(/^debug-\d{4}-\d{2}-\d{2}\.log$/)) {
          continue;
        }

        const filePath = join(this.logsDir, file);

        try {
          const fileStats = statSync(filePath);

          // Track oldest/newest file dates
          if (!stats.oldestFileDate || fileStats.mtimeMs < stats.oldestFileDate.getTime()) {
            stats.oldestFileDate = new Date(fileStats.mtimeMs);
          }
          if (!stats.newestFileDate || fileStats.mtimeMs > stats.newestFileDate.getTime()) {
            stats.newestFileDate = new Date(fileStats.mtimeMs);
          }

          // Check if file is old enough to delete
          if (fileStats.mtimeMs < cutoffTime) {
            stats.bytesFreed += fileStats.size;
            stats.debugLogsDeleted++;

            if (!dryRun) {
              unlinkSync(filePath);
            }
          }
        } catch {
          // Skip files we can't access
        }
      }
    } catch {
      // Logs directory doesn't exist or can't be read
    }
  }

  /**
   * Clean session files
   */
  private cleanSessions(cutoffTime: number, dryRun: boolean, stats: CleanupStats): void {
    try {
      if (!existsSync(this.sessionsDir)) {
        return;
      }

      const files = readdirSync(this.sessionsDir);

      // UUID pattern for session IDs
      const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

      // Group files by session ID
      const sessionFiles = new Map<string, string[]>();

      for (const file of files) {
        // Skip non-session files
        if (!file.endsWith('.json') && !file.endsWith('.jsonl')) continue;

        // Extract session ID from filename
        // Patterns: <uuid>.json, completed_<uuid>.json, <uuid>_metrics.jsonl, <uuid>_conversation.jsonl
        let sessionId: string | null = null;

        if (file.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/)) {
          // UUID.json
          sessionId = file.replace('.json', '');
        } else if (file.match(/^completed_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/)) {
          // completed_UUID.json
          sessionId = file.replace('completed_', '').replace('.json', '');
        } else if (file.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}_metrics\.jsonl$/)) {
          // UUID_metrics.jsonl
          sessionId = file.replace('_metrics.jsonl', '');
        } else if (file.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}_conversation\.jsonl$/)) {
          // UUID_conversation.jsonl
          sessionId = file.replace('_conversation.jsonl', '');
        }

        // Only process files with valid UUID session IDs
        if (!sessionId || !uuidPattern.test(sessionId)) continue;

        if (!sessionFiles.has(sessionId)) {
          sessionFiles.set(sessionId, []);
        }
        sessionFiles.get(sessionId)!.push(file);
      }

      // Check each session
      for (const [sessionId, files] of sessionFiles.entries()) {
        const sessionFile = join(this.sessionsDir, `${sessionId}.json`);

        try {
          const fileStats = statSync(sessionFile);

          // Track oldest/newest session dates
          if (!stats.oldestFileDate || fileStats.mtimeMs < stats.oldestFileDate.getTime()) {
            stats.oldestFileDate = new Date(fileStats.mtimeMs);
          }
          if (!stats.newestFileDate || fileStats.mtimeMs > stats.newestFileDate.getTime()) {
            stats.newestFileDate = new Date(fileStats.mtimeMs);
          }

          // Check if session is old enough to delete
          if (fileStats.mtimeMs < cutoffTime) {
            // Delete all files associated with this session
            for (const file of files) {
              const filePath = join(this.sessionsDir, file);
              try {
                const fileStats = statSync(filePath);
                stats.bytesFreed += fileStats.size;
                if (!dryRun) {
                  unlinkSync(filePath);
                }
              } catch {
                // Skip files we can't delete
              }
            }

            stats.sessionsDeleted++;
          }
        } catch {
          // Session metadata file doesn't exist or can't be read
        }
      }
    } catch {
      // Sessions directory doesn't exist or can't be read
    }
  }

  /**
   * Get total size of all log files
   */
  getLogsSize(): number {
    let totalBytes = 0;

    try {
      if (!existsSync(this.logsDir)) {
        return 0;
      }

      const files = readdirSync(this.logsDir);
      for (const file of files) {
        const filePath = join(this.logsDir, file);
        try {
          const stats = statSync(filePath);
          totalBytes += stats.size;
        } catch {
          // Skip files we can't stat
        }
      }
    } catch {
      // Directory doesn't exist
    }

    return totalBytes;
  }

  /**
   * Get total size of all session files
   */
  getSessionsSize(): number {
    let totalBytes = 0;

    try {
      if (!existsSync(this.sessionsDir)) {
        return 0;
      }

      const files = readdirSync(this.sessionsDir);
      for (const file of files) {
        const filePath = join(this.sessionsDir, file);
        try {
          const stats = statSync(filePath);
          totalBytes += stats.size;
        } catch {
          // Skip files we can't stat
        }
      }
    } catch {
      // Directory doesn't exist
    }

    return totalBytes;
  }
}
