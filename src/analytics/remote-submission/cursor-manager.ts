/**
 * Cursor Manager - Event-Level Tracking
 *
 * Manages cursor state for tracking which events have been submitted
 * to prevent duplicate submissions across concurrent proxy instances.
 *
 * Uses event-level tracking (message IDs, tool call IDs) instead of
 * session-level hashes to handle incremental session updates correctly.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  CursorState,
  AgentCursorState,
  SessionSubmissionState
} from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Default cursor state
 */
function createDefaultCursor(): CursorState {
  return {
    version: 2,
    lastRun: new Date().toISOString(),
    agents: {},
    stats: {
      totalSessionsSubmitted: 0,
      totalMetricsSubmitted: 0,
      consecutiveFailures: 0
    }
  };
}

/**
 * Default agent cursor state
 */
function createDefaultAgentCursor(): AgentCursorState {
  return {
    lastScan: new Date().toISOString(),
    sessions: {}
  };
}

/**
 * Default session submission state
 */
function createDefaultSessionState(): SessionSubmissionState {
  return {
    submitted: false,
    timestamp: new Date().toISOString(),
    sentEventIds: {
      messages: [],
      toolCalls: []
    },
    sessionMetrics: {
      timeoutSent: false,
      resumedSent: false,
      completedSent: false
    },
    lastActivityTime: new Date().toISOString(),
    metricsSubmitted: 0,
    lastUpdate: new Date().toISOString()
  };
}

/**
 * Cursor Manager
 */
export class CursorManager {
  private cursorPath: string;

  constructor(analyticsDir?: string) {
    const baseDir = analyticsDir || join(homedir(), '.codemie', 'analytics');
    this.cursorPath = join(baseDir, 'cursor.json');
  }

  /**
   * Ensure analytics directory exists
   */
  private async ensureDir(): Promise<void> {
    const dir = join(this.cursorPath, '..');
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  /**
   * Load cursor state from disk
   */
  async load(): Promise<CursorState> {
    await this.ensureDir();

    if (!existsSync(this.cursorPath)) {
      return createDefaultCursor();
    }

    try {
      const content = await readFile(this.cursorPath, 'utf-8');
      const cursor = JSON.parse(content) as CursorState;

      // Validate version
      if (cursor.version !== 2) {
        logger.debug(`Cursor version ${cursor.version} not supported, resetting`);
        return createDefaultCursor();
      }

      return cursor;
    } catch (error) {
      logger.debug(`Failed to load cursor: ${error}`);
      return createDefaultCursor();
    }
  }

  /**
   * Save cursor state to disk
   */
  async save(cursor: CursorState): Promise<void> {
    await this.ensureDir();

    try {
      cursor.lastRun = new Date().toISOString();
      const content = JSON.stringify(cursor, null, 2);
      await writeFile(this.cursorPath, content, 'utf-8');
    } catch (error) {
      logger.debug(`Failed to save cursor: ${error}`);
      throw error;
    }
  }

  /**
   * Get or create agent cursor state
   */
  getAgentCursor(cursor: CursorState, agentName: string): AgentCursorState {
    if (!cursor.agents[agentName]) {
      cursor.agents[agentName] = createDefaultAgentCursor();
    }
    return cursor.agents[agentName];
  }

  /**
   * Get or create session submission state
   */
  getSessionState(
    agentCursor: AgentCursorState,
    sessionId: string
  ): SessionSubmissionState {
    if (!agentCursor.sessions[sessionId]) {
      agentCursor.sessions[sessionId] = createDefaultSessionState();
    }
    return agentCursor.sessions[sessionId];
  }

  /**
   * Update session state with sent events
   */
  updateSessionState(
    cursor: CursorState,
    agentName: string,
    sessionId: string,
    updates: {
      newMessageIds?: string[];
      newToolCallIds?: string[];
      metricsSubmitted: number;
      lastActivityTime: string;
      sessionMetrics?: Partial<SessionSubmissionState['sessionMetrics']>;
    }
  ): void {
    const agentCursor = this.getAgentCursor(cursor, agentName);
    const sessionState = this.getSessionState(agentCursor, sessionId);

    // Append new event IDs
    if (updates.newMessageIds) {
      sessionState.sentEventIds.messages.push(...updates.newMessageIds);
    }
    if (updates.newToolCallIds) {
      sessionState.sentEventIds.toolCalls.push(...updates.newToolCallIds);
    }

    // Update session metrics
    if (updates.sessionMetrics) {
      sessionState.sessionMetrics = {
        ...sessionState.sessionMetrics,
        ...updates.sessionMetrics
      };
    }

    // Update metadata
    sessionState.submitted = true;
    sessionState.metricsSubmitted += updates.metricsSubmitted;
    sessionState.lastActivityTime = updates.lastActivityTime;
    sessionState.lastUpdate = new Date().toISOString();

    // Update global stats
    cursor.stats.totalMetricsSubmitted += updates.metricsSubmitted;
  }

  /**
   * Check if event was already sent
   */
  isEventSent(
    sessionState: SessionSubmissionState,
    eventId: string,
    eventType: 'message' | 'toolCall'
  ): boolean {
    const sentIds = eventType === 'message'
      ? sessionState.sentEventIds.messages
      : sessionState.sentEventIds.toolCalls;

    return sentIds.includes(eventId);
  }

  /**
   * Filter events to only include those not yet sent
   */
  filterNewEvents<T extends { messageId?: string; toolCallId?: string }>(
    events: T[],
    sessionState: SessionSubmissionState,
    eventType: 'message' | 'toolCall'
  ): T[] {
    return events.filter(event => {
      const eventId = eventType === 'message'
        ? event.messageId
        : event.toolCallId;

      if (!eventId) return false;

      return !this.isEventSent(sessionState, eventId, eventType);
    });
  }

  /**
   * Increment failure count
   */
  recordFailure(cursor: CursorState): void {
    cursor.stats.consecutiveFailures++;
  }

  /**
   * Reset failure count
   */
  resetFailures(cursor: CursorState): void {
    cursor.stats.consecutiveFailures = 0;
  }

  /**
   * Update scan timestamp for agent
   */
  updateScanTime(cursor: CursorState, agentName: string): void {
    const agentCursor = this.getAgentCursor(cursor, agentName);
    agentCursor.lastScan = new Date().toISOString();
  }
}
