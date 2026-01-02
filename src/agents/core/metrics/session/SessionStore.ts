/**
 * Session Store
 *
 * Manages persistence of metrics session data to JSON files.
 * One file per session: ~/.codemie/metrics/sessions/{sessionId}.json
 */

import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { MetricsSession } from '../types.js';
import { getSessionPath, getMetricsPath, METRICS_PATHS } from '../../metrics-config.js';
import { logger } from '../../../../utils/logger.js';
import { createErrorContext, formatErrorForLog } from '../../../../utils/errors.js';

export class SessionStore {
  /**
   * Save session to disk
   * Path: ~/.codemie/metrics/sessions/{sessionId}.json
   */
  async saveSession(session: MetricsSession): Promise<void> {
    const sessionPath = getSessionPath(session.sessionId);

    try {
      // Ensure directory exists
      const dir = dirname(sessionPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      // Write session data (metrics path is now derived from sessionId)
      await writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8');

      logger.debug(`[SessionStore] Saved session: ${session.sessionId}`);
    } catch (error) {
      const errorContext = createErrorContext(error, { sessionId: session.sessionId });
      logger.error(`[SessionStore] Failed to save session: ${session.sessionId}`, formatErrorForLog(errorContext));
      throw error;
    }
  }

  /**
   * Load session from disk
   */
  async loadSession(sessionId: string): Promise<MetricsSession | null> {
    const sessionPath = getSessionPath(sessionId);

    if (!existsSync(sessionPath)) {
      logger.debug(`[SessionStore] Session file not found: ${sessionId}`);
      return null;
    }

    try {
      const content = await readFile(sessionPath, 'utf-8');
      const session = JSON.parse(content) as MetricsSession;

      logger.debug(`[SessionStore] Loaded session: ${sessionId}`);
      return session;
    } catch (error) {
      const errorContext = createErrorContext(error, { sessionId });
      logger.error(`[SessionStore] Failed to load session: ${sessionId}`, formatErrorForLog(errorContext));
      return null;
    }
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<MetricsSession[]> {
    const sessionsDir = getMetricsPath(METRICS_PATHS.sessions);

    if (!existsSync(sessionsDir)) {
      return [];
    }

    try {
      const files = await readdir(sessionsDir);
      const sessions: MetricsSession[] = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const sessionId = file.replace('.json', '');
          const session = await this.loadSession(sessionId);
          if (session) {
            sessions.push(session);
          }
        }
      }

      return sessions;
    } catch (error) {
      const errorContext = createErrorContext(error);
      logger.error('[SessionStore] Failed to list sessions', formatErrorForLog(errorContext));
      return [];
    }
  }

  /**
   * List active sessions (status === 'active')
   */
  async listActiveSessions(): Promise<MetricsSession[]> {
    const allSessions = await this.listSessions();
    return allSessions.filter(s => s.status === 'active');
  }

  /**
   * Update session status
   */
  async updateSessionStatus(sessionId: string, status: MetricsSession['status']): Promise<void> {
    const session = await this.loadSession(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.status = status;
    if (status === 'completed' || status === 'recovered' || status === 'failed') {
      session.endTime = Date.now();
    }

    await this.saveSession(session);
  }

  /**
   * Update session correlation
   */
  async updateSessionCorrelation(
    sessionId: string,
    correlation: Partial<MetricsSession['correlation']>
  ): Promise<void> {
    const session = await this.loadSession(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.correlation = {
      ...session.correlation,
      ...correlation
    };

    await this.saveSession(session);
  }

  /**
   * Update session watermark
   */
  async updateSessionWatermark(
    sessionId: string,
    watermark: MetricsSession['watermark']
  ): Promise<void> {
    const session = await this.loadSession(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.watermark = watermark;
    await this.saveSession(session);
  }

  /**
   * Update monitoring state
   */
  async updateMonitoringState(
    sessionId: string,
    monitoring: Partial<MetricsSession['monitoring']>
  ): Promise<void> {
    const session = await this.loadSession(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.monitoring = {
      ...session.monitoring,
      ...monitoring
    };

    await this.saveSession(session);
  }
}
