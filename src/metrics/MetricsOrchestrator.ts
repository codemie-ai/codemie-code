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
import { DeltaWriter } from './core/DeltaWriter.js';
import { SyncStateManager } from './core/SyncStateManager.js';
import type { AgentMetricsSupport, MetricsSession, FileSnapshot } from './types.js';
import { METRICS_CONFIG } from './config.js';
import { logger } from '../utils/logger.js';
import { watch } from 'fs';

export interface MetricsOrchestratorOptions {
  sessionId?: string; // Optional: provide existing session ID
  agentName: string;
  provider: string;
  project?: string; // SSO project name (optional, only for ai-run-sso provider)
  workingDirectory: string;
  metricsAdapter: AgentMetricsSupport;
}

export class MetricsOrchestrator {
  private sessionId: string;
  private agentName: string;
  private provider: string;
  private project?: string;
  private workingDirectory: string;
  private metricsAdapter: AgentMetricsSupport;

  private snapshotter: FileSnapshotter;
  private correlator: SessionCorrelator;
  private store: SessionStore;

  // Delta-based components
  private deltaWriter: DeltaWriter | null = null;
  private syncStateManager: SyncStateManager | null = null;
  private fileWatcher: ReturnType<typeof watch> | null = null;

  private beforeSnapshot: FileSnapshot | null = null;
  private session: MetricsSession | null = null;
  private isCollecting: boolean = false;

  constructor(options: MetricsOrchestratorOptions) {
    this.sessionId = options.sessionId || randomUUID();
    this.agentName = options.agentName;
    this.provider = options.provider;
    this.project = options.project;
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
      logger.debug('[MetricsOrchestrator] Taking pre-spawn snapshot...');

      // Get agent data paths
      const { sessionsDir } = this.metricsAdapter.getDataPaths();

      // Take snapshot
      this.beforeSnapshot = await this.snapshotter.snapshot(sessionsDir);

      logger.debug(`[MetricsOrchestrator] Pre-spawn snapshot: ${this.beforeSnapshot.files.length} files`);

      // Create session record
      this.session = {
        sessionId: this.sessionId,
        agentName: this.agentName,
        provider: this.provider,
        ...(this.project && { project: this.project }),
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
      logger.debug(`[MetricsOrchestrator] Session created: ${this.sessionId}`);

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
      logger.debug('[MetricsOrchestrator] Waiting for agent initialization...');

      // Wait for agent to initialize and create session file
      const initDelay = this.metricsAdapter.getInitDelay();
      await this.sleep(initDelay);

      logger.debug('[MetricsOrchestrator] Taking post-spawn snapshot...');

      // Get agent data paths
      const { sessionsDir } = this.metricsAdapter.getDataPaths();

      // Take snapshot
      const afterSnapshot = await this.snapshotter.snapshot(sessionsDir);
      logger.debug(`[MetricsOrchestrator] Post-spawn snapshot: ${afterSnapshot.files.length} files`);

      // Compute diff
      const newFiles = this.snapshotter.diff(this.beforeSnapshot, afterSnapshot);
      logger.debug(`[MetricsOrchestrator] Detected ${newFiles.length} new file(s)`);

      // Correlate with retry
      logger.debug('[MetricsOrchestrator] Starting correlation with retry...');
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

      // Reload session to get updated correlation
      this.session = await this.store.loadSession(this.sessionId);

      if (correlation.status === 'matched') {
        logger.debug(`[MetricsOrchestrator] Session correlated: ${correlation.agentSessionId}`);
        logger.debug(`[MetricsOrchestrator]   Agent file: ${correlation.agentSessionFile}`);
        logger.debug(`[MetricsOrchestrator]   Retry count: ${correlation.retryCount}`);

        // Start incremental delta monitoring
        await this.startIncrementalMonitoring(correlation.agentSessionFile!);
      } else {
        logger.warn(`[MetricsOrchestrator] Correlation failed after ${correlation.retryCount} retries`);
      }

    } catch (error) {
      logger.error('[MetricsOrchestrator] Failed in post-spawn phase:', error);
      // Don't throw - metrics failures shouldn't break agent execution
    }
  }

  /**
   * Finalize session on agent exit
   * Called when agent process exits
   */
  async onAgentExit(exitCode: number): Promise<void> {
    if (!this.isEnabled() || !this.session) {
      return;
    }

    try {
      logger.debug('[MetricsOrchestrator] Finalizing session...');

      // Stop file watcher
      if (this.fileWatcher) {
        this.fileWatcher.close();
        this.fileWatcher = null;
        logger.debug('[MetricsOrchestrator] Stopped file watcher');
      }

      // Collect final deltas
      if (this.session.correlation.status === 'matched' &&
          this.session.correlation.agentSessionFile) {
        await this.collectDeltas(this.session.correlation.agentSessionFile);
        logger.debug('[MetricsOrchestrator] Collected final deltas');
      }

      // Update sync state status with end time
      const endTime = Date.now();
      const status = exitCode === 0 ? 'completed' : 'failed';

      if (this.syncStateManager) {
        await this.syncStateManager.updateStatus(status, endTime);
      }

      // Update session status
      await this.store.updateSessionStatus(this.sessionId, status);

      logger.debug('[MetricsOrchestrator] Session finalized');

    } catch (error) {
      logger.error('[MetricsOrchestrator] Failed to finalize session:', error);
      // Don't throw - metrics failures shouldn't break agent execution
    }
  }

  /**
   * Start incremental monitoring with delta collection
   */
  private async startIncrementalMonitoring(sessionFilePath: string): Promise<void> {
    if (!this.session || !this.session.correlation.agentSessionId) {
      logger.warn('[MetricsOrchestrator] Cannot start monitoring without correlated session');
      return;
    }

    try {
      // Initialize delta writer and sync state manager
      this.deltaWriter = new DeltaWriter(this.sessionId);
      this.syncStateManager = new SyncStateManager(this.sessionId);

      // Initialize sync state with session start time
      await this.syncStateManager.initialize(
        this.sessionId,
        this.session.correlation.agentSessionId,
        this.session.startTime
      );

      logger.debug('[MetricsOrchestrator] Initialized delta-based metrics tracking');

      // Collect initial deltas
      await this.collectDeltas(sessionFilePath);

      // Start file watching
      let debounceTimer: NodeJS.Timeout | null = null;
      const DEBOUNCE_DELAY = 5000; // 5 seconds

      this.fileWatcher = watch(sessionFilePath, (eventType) => {
        if (eventType === 'change') {
          // Debounce: wait 5s after last change before collecting
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }

          debounceTimer = setTimeout(async () => {
            await this.collectDeltas(sessionFilePath);
          }, DEBOUNCE_DELAY);
        }
      });

      logger.debug('[MetricsOrchestrator] Started file watching for incremental metrics');

    } catch (error) {
      logger.error('[MetricsOrchestrator] Failed to start incremental monitoring:', error);
    }
  }

  /**
   * Collect delta metrics from agent session file
   */
  private async collectDeltas(sessionFilePath: string): Promise<void> {
    // Prevent concurrent collection
    if (this.isCollecting || !this.deltaWriter || !this.syncStateManager) {
      return;
    }

    this.isCollecting = true;

    try {
      // Load current sync state
      const syncState = await this.syncStateManager.load();

      // If sync state doesn't exist (file deleted or not initialized yet), skip collection
      if (!syncState) {
        logger.debug('[MetricsOrchestrator] Sync state not available, skipping delta collection');
        this.isCollecting = false;
        return;
      }

      // Get already-processed record IDs from sync state
      const processedRecordIds = new Set(syncState.processedRecordIds);

      // Get already-attached user prompt texts from sync state
      const attachedUserPromptTexts = new Set(syncState.attachedUserPromptTexts || []);

      // Parse incremental metrics with processed record IDs and attached prompts
      const { deltas, lastLine, newlyAttachedPrompts } = await this.metricsAdapter.parseIncrementalMetrics(
        sessionFilePath,
        processedRecordIds,
        attachedUserPromptTexts
      );

      if (deltas.length === 0) {
        logger.debug('[MetricsOrchestrator] No new deltas to collect');
        this.isCollecting = false;
        return;
      }

      logger.debug(`[MetricsOrchestrator] Collected ${deltas.length} new delta(s)`);

      // Collect record IDs for tracking
      const newRecordIds: string[] = [];

      // Append each delta to JSONL
      for (const delta of deltas) {
        // Set CodeMie session ID
        delta.sessionId = this.sessionId;

        // Append to JSONL
        await this.deltaWriter.appendDelta(delta);
        newRecordIds.push(delta.recordId);
      }

      // Update sync state with processed record IDs
      await this.syncStateManager.addProcessedRecords(newRecordIds);
      await this.syncStateManager.updateLastProcessed(lastLine, Date.now());
      await this.syncStateManager.incrementDeltas(deltas.length);

      // Update sync state with newly attached user prompts
      if (newlyAttachedPrompts && newlyAttachedPrompts.length > 0) {
        await this.syncStateManager.addAttachedUserPrompts(newlyAttachedPrompts);
      }

      logger.debug(`[MetricsOrchestrator] Processed up to line ${lastLine}`);

    } catch (error) {
      logger.error('[MetricsOrchestrator] Failed to collect deltas:', error);
    } finally {
      this.isCollecting = false;
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
