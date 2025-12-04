/**
 * Remote Analytics Submitter
 *
 * Orchestrates periodic submission of analytics metrics to /v1/metrics endpoint.
 * Handles event-level tracking, concurrency control, and backend-aligned metrics.
 *
 * Key Features:
 * - 5-minute submission interval
 * - Event-level tracking (message IDs, tool call IDs)
 * - Multi-terminal safety via file locking
 * - Inactivity-based session end detection
 * - Backend-aligned metric transformation (3+1 pattern)
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AgentRegistry } from '../../agents/registry.js';
import type { AgentAnalyticsAdapter } from '../aggregation/core/adapter.interface.js';
import type { CodemieSession, CodemieMessage } from '../aggregation/types.js';
import type {
  RemoteSubmissionConfig,
  MetricPayload,
  CursorState,
  SessionStatus
} from './types.js';
import { CursorManager } from './cursor-manager.js';
import { LockManager } from './lock-manager.js';
import { createSessionMetric } from './metric-transformer.js';
import { logger } from '../../utils/logger.js';

/**
 * Remote Analytics Submitter
 */
export class RemoteAnalyticsSubmitter {
  private config: RemoteSubmissionConfig;
  private cursorManager: CursorManager;
  private lockManager: LockManager;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(config: RemoteSubmissionConfig) {
    this.config = config;
    this.cursorManager = new CursorManager();
    this.lockManager = new LockManager();
  }

  /**
   * Start periodic submission
   */
  start(): void {
    if (this.intervalTimer) {
      logger.debug('RemoteAnalyticsSubmitter already started');
      return;
    }

    logger.debug(`Starting remote analytics submission (interval: ${this.config.interval}ms)`);

    // Run immediately, then periodically
    this.submitCycle().catch(error => {
      logger.debug(`Initial submission cycle failed: ${error}`);
    });

    this.intervalTimer = setInterval(() => {
      this.submitCycle().catch(error => {
        logger.debug(`Submission cycle failed: ${error}`);
      });
    }, this.config.interval);

    // Ensure timer doesn't prevent process exit
    this.intervalTimer.unref();
  }

  /**
   * Stop periodic submission
   */
  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
      logger.debug('Remote analytics submission stopped');
    }
  }

  /**
   * Main submission cycle
   */
  private async submitCycle(): Promise<void> {
    // Prevent overlapping cycles
    if (this.isRunning) {
      logger.debug('Submission cycle already running, skipping');
      return;
    }

    this.isRunning = true;

    try {
      // 1. Acquire lock (with retry)
      const lockAcquired = await this.lockManager.acquire('remote-submitter', 3);
      if (!lockAcquired) {
        logger.debug('Could not acquire lock, skipping cycle');
        return;
      }

      // 2. Load cursor
      const cursor = await this.cursorManager.load();

      // 3. Process all external agents
      await this.processExternalAgents(cursor);

      // 4. Save cursor
      await this.cursorManager.save(cursor);
      this.cursorManager.resetFailures(cursor);
    } catch (error) {
      logger.debug(`Submission cycle error: ${error}`);
      const cursor = await this.cursorManager.load();
      this.cursorManager.recordFailure(cursor);
      await this.cursorManager.save(cursor);
    } finally {
      // 5. Release lock
      await this.lockManager.release();
      this.isRunning = false;
    }
  }

  /**
   * Process all external agents
   */
  private async processExternalAgents(cursor: CursorState): Promise<void> {
    // Get all analytics adapters from registry
    const adapters = AgentRegistry.getAllAnalyticsAdapters();

    for (const adapter of adapters) {
      // Skip native agent
      if (adapter.agentName === 'codemie-code') {
        continue;
      }

      try {
        // Validate source
        if (!(await adapter.validateSource())) {
          logger.debug(`Data source not available for ${adapter.displayName}, skipping`);
          continue;
        }

        // Process agent
        await this.processAgent(adapter, cursor);

        // Update scan time
        this.cursorManager.updateScanTime(cursor, adapter.agentName);
      } catch (error) {
        logger.debug(`Failed to process agent ${adapter.displayName}: ${error}`);
      }
    }
  }

  /**
   * Process single agent
   */
  private async processAgent(
    adapter: AgentAnalyticsAdapter,
    cursor: CursorState
  ): Promise<void> {
    logger.debug(`Processing ${adapter.displayName}...`);

    // Find all sessions
    const descriptors = await adapter.findSessions();
    logger.debug(`Found ${descriptors.length} sessions for ${adapter.displayName}`);

    // Process each session
    for (const descriptor of descriptors) {
      try {
        await this.processSession(adapter, descriptor, cursor);
      } catch (error) {
        logger.debug(`Failed to process session ${descriptor.sessionId}: ${error}`);
      }
    }
  }

  /**
   * Process single session
   */
  private async processSession(
    adapter: AgentAnalyticsAdapter,
    descriptor: any,
    cursor: CursorState
  ): Promise<void> {
    const sessionId = descriptor.sessionId;
    const agentCursor = this.cursorManager.getAgentCursor(cursor, adapter.agentName);
    const sessionState = this.cursorManager.getSessionState(agentCursor, sessionId);

    // Extract session and raw events
    const [session, rawData] = await Promise.all([
      adapter.extractSession(descriptor),
      adapter.extractRawEvents(descriptor)
    ]);

    // Filter to NEW events only (not yet sent)
    const newMessages = this.cursorManager.filterNewEvents(
      rawData.messages,
      sessionState,
      'message'
    );

    const newToolCalls = this.cursorManager.filterNewEvents(
      rawData.toolCalls,
      sessionState,
      'toolCall'
    );

    // Check session status
    const status = this.determineSessionStatus(session, rawData, sessionState);
    const metricsToSubmit: MetricPayload[] = [];

    // Track new activity for cursor updates
    const hasNewActivity = newToolCalls.length > 0 || newMessages.length > 0;

    if (hasNewActivity) {
      logger.debug(
        `Session ${sessionId}: ${newToolCalls.length} new tool calls, ` +
        `${newMessages.length} new messages`
      );
    } else {
      logger.debug(`Session ${sessionId}: no new events`);
    }

    // Generate session metric (only when session ends or resumes)
    const sessionMetric = await this.maybeSubmitSessionMetric(
      session,
      rawData,
      sessionState,
      status
    );

    if (sessionMetric) {
      metricsToSubmit.push(sessionMetric);
    }

    // 3. Submit metrics
    if (metricsToSubmit.length > 0) {
      await this.submitBatch(metricsToSubmit);

      // 4. Update cursor
      this.cursorManager.updateSessionState(
        cursor,
        adapter.agentName,
        sessionId,
        {
          newMessageIds: newMessages.map(m => m.messageId),
          newToolCallIds: newToolCalls.map(tc => tc.toolCallId),
          metricsSubmitted: metricsToSubmit.length,
          lastActivityTime: this.getLastActivityTime(session, rawData).toISOString(),
          sessionMetrics: sessionMetric ? {
            timeoutSent: status === 'ended' && !session.endTime,
            resumedSent: sessionState.sessionMetrics.timeoutSent && newToolCalls.length > 0,
            completedSent: !!session.endTime
          } : undefined
        }
      );

      // Update global stats
      if (!sessionState.submitted) {
        cursor.stats.totalSessionsSubmitted++;
      }

      logger.debug(`✓ Submitted ${metricsToSubmit.length} metrics for session ${sessionId}`);
    } else {
      logger.debug(`Session ${sessionId}: no metrics to submit`);
    }
  }

  /**
   * Determine session status based on activity
   */
  private determineSessionStatus(
    session: CodemieSession,
    rawData: { messages: CodemieMessage[] },
    sessionState: any
  ): SessionStatus {
    // Already sent final metric
    if (sessionState.sessionMetrics.completedSent) {
      return 'final';
    }

    // Explicit end time
    if (session.endTime) {
      return 'ended';
    }

    // Check inactivity
    const lastActivity = this.getLastActivityTime(session, rawData);
    const inactiveMs = Date.now() - lastActivity.getTime();

    // Import SESSION_TIMEOUTS
    const { INACTIVE, ENDED } = {
      INACTIVE: 30 * 60 * 1000,
      ENDED: 24 * 60 * 60 * 1000
    };

    if (inactiveMs < INACTIVE) {
      return 'active';
    } else if (inactiveMs < ENDED) {
      return 'inactive';
    } else {
      return 'ended';
    }
  }

  /**
   * Get last activity time from session
   */
  private getLastActivityTime(
    session: CodemieSession,
    rawData: { messages: CodemieMessage[] }
  ): Date {
    // Priority: explicit endTime > latest message timestamp > startTime
    if (session.endTime) return session.endTime;

    // Get latest timestamp from messages
    const messageTimes = rawData.messages.map(m => m.timestamp.getTime());
    if (messageTimes.length > 0) {
      return new Date(Math.max(...messageTimes));
    }

    return session.startTime;
  }

  /**
   * Maybe submit session metric based on status
   */
  private async maybeSubmitSessionMetric(
    session: CodemieSession,
    rawData: any,
    sessionState: any,
    status: SessionStatus
  ): Promise<MetricPayload | null> {
    const sessionMetrics = sessionState.sessionMetrics;

    // Case 1: Explicit end (ideal case)
    if (session.endTime && !sessionMetrics.completedSent) {
      return createSessionMetric(
        session,
        rawData,
        {
          exitReason: session.exitReason || 'user_exit'
        }
      );
    }

    // Case 2: Inactivity timeout (24 hours)
    if (status === 'ended' && !sessionMetrics.timeoutSent) {
      return createSessionMetric(
        session,
        rawData,
        {
          exitReason: 'inactivity_timeout'
        }
      );
    }

    // Case 3: Resumed after timeout (new activity after timeout was sent)
    if (sessionMetrics.timeoutSent && !sessionMetrics.resumedSent) {
      // Check if there are new events
      const hasNewActivity = rawData.toolCalls.length > sessionState.sentEventIds.toolCalls.length;
      if (hasNewActivity) {
        return createSessionMetric(
          session,
          rawData,
          {
            exitReason: 'resumed_after_timeout'
          }
        );
      }
    }

    return null;
  }

  /**
   * Submit batch of metrics - writes to local file and/or remote endpoint
   */
  private async submitBatch(metrics: MetricPayload[]): Promise<void> {
    // Write to local file if target is 'local' or 'both'
    if (this.config.target === 'local' || this.config.target === 'both') {
      await this.writeMetricsToLocalFile(metrics);
    }

    // Submit to remote endpoint if target is 'remote' or 'both'
    if (this.config.target === 'remote' || this.config.target === 'both') {
      // Skip remote submission if credentials not available
      if (this.config.baseUrl && this.config.cookies) {
        await this.submitToRemote(metrics);
      } else {
        logger.debug('Remote submission skipped: baseUrl or cookies not configured');
      }
    }
  }

  /**
   * Write metrics to local JSONL file
   */
  private async writeMetricsToLocalFile(metrics: MetricPayload[]): Promise<void> {
    try {
      // Get today's date for filename
      const today = new Date().toISOString().split('T')[0];
      const analyticsDir = join(homedir(), '.codemie', 'analytics');
      const filePath = join(analyticsDir, `${today}.jsonl`);

      // Ensure directory exists
      if (!existsSync(analyticsDir)) {
        await mkdir(analyticsDir, { recursive: true });
      }

      // Write metrics as JSONL (one JSON object per line)
      const lines = metrics.map(metric => JSON.stringify(metric)).join('\n') + '\n';

      // Append to file (or create if doesn't exist)
      await appendFile(filePath, lines, 'utf-8');

      logger.debug(`Wrote ${metrics.length} metrics to ${filePath}`);
    } catch (error) {
      logger.debug(`Failed to write metrics to local file: ${error}`);
      throw error;
    }
  }

  /**
   * Submit metrics to remote /v1/metrics endpoint
   * Note: Caller should verify baseUrl and cookies are set before calling
   */
  private async submitToRemote(metrics: MetricPayload[]): Promise<void> {
    // Create batches
    const batches = this.createBatches(metrics, this.config.batchSize);

    for (const batch of batches) {
      try {
        const response = await fetch(`${this.config.baseUrl!}/v1/metrics`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': this.config.cookies!
          },
          body: JSON.stringify(batch)
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        logger.debug(`Submitted batch of ${batch.length} metrics to remote endpoint`);
      } catch (error) {
        logger.debug(`Failed to submit batch to remote: ${error}`);
        throw error;
      }
    }
  }

  /**
   * Create batches from metrics
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }
}
