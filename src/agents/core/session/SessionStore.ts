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

  /**
   * Start activity tracking for a session
   * Sets activityStartedAt to current time if not already set (prevents double-counting)
   *
   * @param sessionId - The session ID to start tracking
   */
  async startActivityTracking(sessionId: string): Promise<void> {
    const session = await this.loadSession(sessionId);

    if (!session) {
      logger.warn(`[SessionStore] Cannot start activity tracking - session not found: ${sessionId}`);
      return;
    }

    // Guard: skip if already tracking (prevents double-counting from multiple prompts without Stop)
    if (session.activityStartedAt !== undefined) {
      logger.debug(`[SessionStore] Activity tracking already started for session: ${sessionId}`);
      return;
    }

    session.activityStartedAt = Date.now();
    await this.saveSession(session);

    logger.debug(`[SessionStore] Started activity tracking for session: ${sessionId}`);
  }

  /**
   * Accumulate active duration for a session
   * Calculates duration since activityStartedAt, adds to activeDurationMs, clears activityStartedAt
   *
   * @param sessionId - The session ID to accumulate duration for
   * @returns The duration accumulated in this call (0 if no active period)
   */
  async accumulateActiveDuration(sessionId: string): Promise<number> {
    const session = await this.loadSession(sessionId);

    if (!session) {
      logger.warn(`[SessionStore] Cannot accumulate duration - session not found: ${sessionId}`);
      return 0;
    }

    // Guard: return 0 if no active period (Stop without UserPromptSubmit)
    if (session.activityStartedAt === undefined) {
      logger.debug(`[SessionStore] No active period to accumulate for session: ${sessionId}`);
      return 0;
    }

    const duration = Date.now() - session.activityStartedAt;
    session.activeDurationMs = (session.activeDurationMs || 0) + duration;
    session.activityStartedAt = undefined; // Clear to mark as idle

    await this.saveSession(session);

    logger.debug(`[SessionStore] Accumulated ${duration}ms for session: ${sessionId} (total: ${session.activeDurationMs}ms)`);

    return duration;
  }
}
