/**
 * VersionWarningStore
 *
 * Records one-time "untested version" markers at user scope.
 * Backing file: `~/.codemie/version-warnings.json`.
 *
 * A marker is keyed by (agent, installed agent version) and additionally stores
 * the `supportedVersion` baseline it was acknowledged against. The marker is
 * honoured only while that baseline still matches: a CodeMie release that moves
 * the recommended version forward invalidates old markers and buys exactly one
 * re-notice, while CodeMie releases that leave the baseline alone never re-nag.
 *
 * See EPMCDME-13734.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from './logger.js';
import { getCodemiePath } from './paths.js';

export interface VersionWarningRecord {
  agentName: string;
  agentVersion: string;
  /** Recommended version at the time the notice was acknowledged. */
  supportedVersion: string;
  /** CodeMie version that emitted the notice (context for `codemie doctor`). */
  codemieVersion: string;
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
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return emptyHistory();
      }
      logger.warn('[VersionWarningStore] Corrupt or unreadable file — treating as empty', { file });
      return emptyHistory();
    }
  }

  static async saveHistory(history: VersionWarningHistory): Promise<void> {
    const file = filePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(history, null, 2), 'utf-8');
  }

  /**
   * True when this agent version was already acknowledged against the same
   * recommended baseline. A moved baseline makes the stored marker stale.
   */
  static async hasWarned(
    agentName: string,
    agentVersion: string,
    supportedVersion: string
  ): Promise<boolean> {
    const history = await this.loadHistory();
    return history.warnings.some(
      (warning) =>
        warning.agentName === agentName &&
        warning.agentVersion === agentVersion &&
        warning.supportedVersion === supportedVersion
    );
  }

  static async recordWarning(
    agentName: string,
    agentVersion: string,
    supportedVersion: string,
    codemieVersion: string
  ): Promise<void> {
    const history = await this.loadHistory();
    const others = history.warnings.filter(
      (warning) => !(warning.agentName === agentName && warning.agentVersion === agentVersion)
    );
    others.push({
      agentName,
      agentVersion,
      supportedVersion,
      codemieVersion,
      warnedAt: new Date().toISOString(),
    });
    await this.saveHistory({ version: 1, warnings: others });
  }

  static async clear(): Promise<{ removed: number }> {
    const file = filePath();
    const history = await this.loadHistory();
    const removed = history.warnings.length;
    try {
      await fs.unlink(file);
      return { removed };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { removed: 0 };
      }
      // The user ran the reset intentionally — failing `codemie doctor` here
      // would be worse than reporting "0 removed" and continuing the checks.
      logger.warn('[VersionWarningStore] clear() failed; markers left in place', { file, code });
      return { removed: 0 };
    }
  }
}
