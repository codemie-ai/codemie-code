/**
 * Metrics Orchestrator
 *
 * Coordinates metrics collection across agent lifecycle:
 * 1. Pre-spawn snapshot
 * 2. Post-spawn snapshot + correlation
 * 3. Session creation and persistence
 *
 * Phase 1 & 2 implementation (Phase 3-5 later)
 */

import { randomUUID } from 'crypto';
import { FileSnapshotter } from './core/FileSnapshotter.js';
import { SessionCorrelator } from './core/SessionCorrelator.js';
import { SessionStore } from './session/SessionStore.js';
import type { AgentMetricsSupport, MetricsSession, FileSnapshot } from './types.js';
import { METRICS_CONFIG } from './config.js';
import { logger } from '../utils/logger.js';

export interface MetricsOrchestratorOptions {
  sessionId?: string; // Optional: provide existing session ID
  agentName: string;
  provider: string;
  workingDirectory: string;
  metricsAdapter: AgentMetricsSupport;
}

export class MetricsOrchestrator {
  private sessionId: string;
  private agentName: string;
  private provider: string;
  private workingDirectory: string;
  private metricsAdapter: AgentMetricsSupport;

  private snapshotter: FileSnapshotter;
  private correlator: SessionCorrelator;
  private store: SessionStore;

  private beforeSnapshot: FileSnapshot | null = null;
  private session: MetricsSession | null = null;

  constructor(options: MetricsOrchestratorOptions) {
    this.sessionId = options.sessionId || randomUUID();
    this.agentName = options.agentName;
    this.provider = options.provider;
    this.workingDirectory = options.workingDirectory;
    this.metricsAdapter = options.metricsAdapter;

    this.snapshotter = new FileSnapshotter();
    this.correlator = new SessionCorrelator();
    this.store = new SessionStore();
  }

  /**
   * Check if metrics collection is enabled for this provider
   */
  isEnabled(): boolean {
    return METRICS_CONFIG.enabled(this.provider);
  }

  /**
   * Step 1: Take snapshot before agent spawn
   * Called before spawning the agent process
   */
  async beforeAgentSpawn(): Promise<void> {
    if (!this.isEnabled()) {
      logger.debug('[MetricsOrchestrator] Metrics disabled for provider:', this.provider);
      return;
    }

    try {
      logger.info('[MetricsOrchestrator] Taking pre-spawn snapshot...');

      // Get agent data paths
      const { sessionsDir } = this.metricsAdapter.getDataPaths();

      // Take snapshot
      this.beforeSnapshot = await this.snapshotter.snapshot(sessionsDir);

      logger.info(`[MetricsOrchestrator] Pre-spawn snapshot: ${this.beforeSnapshot.files.length} files`);

      // Create session record
      this.session = {
        sessionId: this.sessionId,
        agentName: this.agentName,
        provider: this.provider,
        startTime: Date.now(),
        workingDirectory: this.workingDirectory,
        status: 'active',
        correlation: {
          status: 'pending',
          retryCount: 0
        },
        monitoring: {
          isActive: false,
          changeCount: 0
        }
      };

      // Save initial session
      await this.store.saveSession(this.session);
      logger.info(`[MetricsOrchestrator] Session created: ${this.sessionId}`);

    } catch (error) {
      logger.error('[MetricsOrchestrator] Failed to take pre-spawn snapshot:', error);
      // Don't throw - metrics failures shouldn't break agent execution
    }
  }

  /**
   * Step 2: Take snapshot after agent spawn + correlate
   * Called after spawning the agent process
   */
  async afterAgentSpawn(): Promise<void> {
    if (!this.isEnabled() || !this.beforeSnapshot || !this.session) {
      return;
    }

    try {
      logger.info('[MetricsOrchestrator] Waiting for agent initialization...');

      // Wait for agent to initialize and create session file
      const initDelay = this.metricsAdapter.getInitDelay();
      await this.sleep(initDelay);

      logger.info('[MetricsOrchestrator] Taking post-spawn snapshot...');

      // Get agent data paths
      const { sessionsDir } = this.metricsAdapter.getDataPaths();

      // Take snapshot
      const afterSnapshot = await this.snapshotter.snapshot(sessionsDir);
      logger.info(`[MetricsOrchestrator] Post-spawn snapshot: ${afterSnapshot.files.length} files`);

      // Compute diff
      const newFiles = this.snapshotter.diff(this.beforeSnapshot, afterSnapshot);
      logger.info(`[MetricsOrchestrator] Detected ${newFiles.length} new file(s)`);

      // Correlate with retry
      logger.info('[MetricsOrchestrator] Starting correlation with retry...');
      const correlation = await this.correlator.correlateWithRetry(
        {
          sessionId: this.sessionId,
          agentName: this.agentName,
          workingDirectory: this.workingDirectory,
          newFiles,
          agentPlugin: this.metricsAdapter
        },
        async () => {
          // Snapshot function for retries
          const retrySnapshot = await this.snapshotter.snapshot(sessionsDir);
          return this.snapshotter.diff(this.beforeSnapshot!, retrySnapshot);
        }
      );

      // Update session with correlation result
      await this.store.updateSessionCorrelation(this.sessionId, correlation);

      if (correlation.status === 'matched') {
        logger.success(`[MetricsOrchestrator] Session correlated: ${correlation.agentSessionId}`);
        logger.info(`[MetricsOrchestrator]   Agent file: ${correlation.agentSessionFile}`);
        logger.info(`[MetricsOrchestrator]   Retry count: ${correlation.retryCount}`);

        // Parse and collect initial metrics
        await this.collectMetrics(correlation.agentSessionFile!);
      } else {
        logger.warn(`[MetricsOrchestrator] Correlation failed after ${correlation.retryCount} retries`);
      }

    } catch (error) {
      logger.error('[MetricsOrchestrator] Failed in post-spawn phase:', error);
      // Don't throw - metrics failures shouldn't break agent execution
    }
  }

  /**
   * Step 3: Collect metrics from agent session file
   * Called when correlation succeeds or on agent exit
   */
  async collectMetrics(sessionFilePath: string): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    try {
      logger.info('[MetricsOrchestrator] Collecting metrics...');

      // Parse session file
      const snapshot = await this.metricsAdapter.parseSessionFile(sessionFilePath);

      logger.info(`[MetricsOrchestrator] Metrics collected:`);
      logger.info(`[MetricsOrchestrator]   Tokens: ${snapshot.tokens?.input} in / ${snapshot.tokens?.output} out`);
      logger.info(`[MetricsOrchestrator]   Cost: $${snapshot.cost?.toFixed(4)}`);
      logger.info(`[MetricsOrchestrator]   Tool calls: ${snapshot.toolCalls?.length || 0} types`);
      logger.info(`[MetricsOrchestrator]   Turns: ${snapshot.turnCount}`);
      logger.info(`[MetricsOrchestrator]   Model: ${snapshot.model}`);

      // TODO: Save metrics to ~/.codemie/metrics/data/{agent}/{session}.json
      // This will be part of Phase 3 or later

    } catch (error) {
      logger.error('[MetricsOrchestrator] Failed to collect metrics:', error);
      // Don't throw - metrics failures shouldn't break agent execution
    }
  }

  /**
   * Step 4: Finalize session on agent exit
   * Called when agent process exits
   */
  async onAgentExit(exitCode: number): Promise<void> {
    if (!this.isEnabled() || !this.session) {
      return;
    }

    try {
      logger.info('[MetricsOrchestrator] Finalizing session...');

      // Update session status
      const status = exitCode === 0 ? 'completed' : 'failed';
      await this.store.updateSessionStatus(this.sessionId, status);

      // If we have a correlated session file, collect final metrics
      if (this.session.correlation.status === 'matched' &&
          this.session.correlation.agentSessionFile) {
        await this.collectMetrics(this.session.correlation.agentSessionFile);
      }

      logger.success('[MetricsOrchestrator] Session finalized');

    } catch (error) {
      logger.error('[MetricsOrchestrator] Failed to finalize session:', error);
      // Don't throw - metrics failures shouldn't break agent execution
    }
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
