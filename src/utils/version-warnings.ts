/**
 * VersionWarningStore
 *
 * Records one-time "untested version" markers per (agent, agent-version)
 * pair at user scope. Backing file: `~/.codemie/version-warnings.json`.
 *
 * Rationale: CodeMie no longer pins per-agent supported-version constants.
 * Instead of blocking on version mismatch, the CLI warns once per unique
 * (agent, agent-version) pair and proceeds. The running CodeMie version is
 * NOT part of the marker key — a CodeMie release must not re-nag users about
 * an agent version they have already acknowledged.
 *
 * See EPMCDME-13734 and docs/superpowers/tasks/2026-08-04-untested-agent-version-warning-non-blocking/spec.md.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './logger.js';
import { getCodemiePath } from './paths.js';

export interface VersionWarningRecord {
  agentName: string;
  agentVersion: string;
  warnedAt: string;
}

export interface VersionWarningHistory {
  version: 1;
  warnings: VersionWarningRecord[];
}

const filePath = (): string => getCodemiePath('version-warnings.json');

const emptyHistory = (): VersionWarningHistory => ({ version: 1, warnings: [] });

export class VersionWarningStore {
  static async loadHistory(): Promise<VersionWarningHistory> {
    const file = filePath();
    try {
      const content = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(content) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { warnings?: unknown }).warnings)
      ) {
        return {
          version: 1,
          warnings: (parsed as { warnings: VersionWarningRecord[] }).warnings,
        };
      }
      return emptyHistory();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return emptyHistory();
      }
      logger.warn('[VersionWarningStore] Corrupt or unreadable file — treating as empty', {
        file,
      });
      return emptyHistory();
    }
  }

  static async saveHistory(history: VersionWarningHistory): Promise<void> {
    const file = filePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(history, null, 2), 'utf-8');
  }

  static async hasWarned(agentName: string, agentVersion: string): Promise<boolean> {
    const history = await this.loadHistory();
    return history.warnings.some(
      (w) => w.agentName === agentName && w.agentVersion === agentVersion,
    );
  }

  static async recordWarning(agentName: string, agentVersion: string): Promise<void> {
    const history = await this.loadHistory();
    const exists = history.warnings.some(
      (w) => w.agentName === agentName && w.agentVersion === agentVersion,
    );
    if (exists) {
      return;
    }
    history.warnings.push({
      agentName,
      agentVersion,
      warnedAt: new Date().toISOString(),
    });
    await this.saveHistory(history);
  }

  static async clear(): Promise<{ removed: number }> {
    const file = filePath();
    const history = await this.loadHistory();
    const removed = history.warnings.length;
    try {
      await fs.unlink(file);
      return { removed };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { removed: 0 };
      }
      // Soft-fail on non-transient errors (EACCES, EROFS, EPERM). The user
      // ran the reset intentionally — crashing `codemie doctor` here would be
      // strictly worse than reporting "0 removed" and continuing the checks.
      logger.warn('[VersionWarningStore] clear() failed; markers left in place', {
        file,
        code,
      });
      return { removed: 0 };
    }
  }
}
