/**
 * Session Store
 *
 * Manages persistence of session data to JSON files.
 * One file per session: ~/.codemie/sessions/{sessionId}.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type { Session } from './types.js';
import { getSessionPath } from './session-config.js';
import { logger } from '../../../utils/logger.js';
import { createErrorContext, formatErrorForLog } from '../../../utils/errors.js';

export class SessionStore {
  /**
   * Save session to disk
   * Path: ~/.codemie/sessions/{sessionId}.json
   */
  async saveSession(session: Session): Promise<void> {
    const sessionPath = getSessionPath(session.sessionId);

    try {
      // Ensure directory exists
      const dir = dirname(sessionPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      // Write session data
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
  async loadSession(sessionId: string): Promise<Session | null> {
    const sessionPath = getSessionPath(sessionId);

    if (!existsSync(sessionPath)) {
      logger.debug(`[SessionStore] Session file not found: ${sessionId}`);
      return null;
    }

    try {
      const content = await readFile(sessionPath, 'utf-8');
      const session = JSON.parse(content) as Session;

      logger.debug(`[SessionStore] Loaded session: ${sessionId}`);
      return session;
    } catch (error) {
      const errorContext = createErrorContext(error, { sessionId });
      logger.error(`[SessionStore] Failed to load session: ${sessionId}`, formatErrorForLog(errorContext));
      return null;
    }
  }


  /**
   * Update session status and reason
   */
  async updateSessionStatus(sessionId: string, status: Session['status'], reason?: string): Promise<void> {
    const session = await this.loadSession(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.status = status;
    if (reason) {
      session.reason = reason;
    }
    if (status === 'completed' || status === 'recovered' || status === 'failed') {
      session.endTime = Date.now();
    }

    await this.saveSession(session);
  }
}
