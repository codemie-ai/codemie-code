/**
 * Session Orchestrator
 *
 * Manages agent session lifecycle and coordinates data collection:
 * 1. Session creation and metadata management
 * 2. Pre-spawn snapshot and post-spawn correlation
 * 3. Metrics delta collection and monitoring
 * 4. Session completion state (used by all processors)
 *
 * Purpose: Provides unified session state that both metrics and conversations
 * processors use. The session acts as the single source of truth for:
 * - Session metadata (agent, provider, working directory)
 * - Correlation with agent session files
 * - Session lifecycle status (active → completed/failed)
 * - Sync state for all processors
 */

import { randomUUID } from 'crypto';
import { FileSnapshotter } from './FileSnapshotter.js';
import { SessionCorrelator } from './SessionCorrelator.js';
import { SessionStore } from './SessionStore.js';
import { DeltaWriter } from '../metrics/DeltaWriter.js';
import { MetricsSyncStateManager } from '../metrics/MetricsSyncStateManager.js';
import type { Session, FileSnapshot, SessionLifecycleAdapter } from './types.js';
import type { AgentMetricsSupport } from '../metrics/types.js';
import { METRICS_CONFIG } from '../metrics-config.js';
import { logger } from '../../../utils/logger.js';
import { watch } from 'fs';
import { detectGitBranch } from '../../../utils/processes.js';
import { createErrorContext, formatErrorForLog } from '../../../utils/errors.js';

export interface SessionTransitionEvent {
  oldSessionId: string;
  newSessionFile: string;
  transitionTimestamp: number;
}

export interface SessionOrchestratorOptions {
  sessionId?: string; // Optional: provide existing session ID
  agentName: string;
  provider: string;
  project?: string; // SSO project name (optional, only for ai-run-sso provider)
  workingDirectory: string;
  metricsAdapter: AgentMetricsSupport;
  lifecycleAdapter?: SessionLifecycleAdapter; // Optional: for session lifecycle detection
  onSessionTransition?: (event: SessionTransitionEvent) => void | Promise<void>; // Optional: callback for session transitions
}

export class SessionOrchestrator {
  private sessionId: string;
  private agentName: string;
  private provider: string;
  private project?: string;
  private workingDirectory: string;
  private metricsAdapter: AgentMetricsSupport;
  private lifecycleAdapter?: SessionLifecycleAdapter;
  private onSessionTransition?: (event: SessionTransitionEvent) => void | Promise<void>;

  private snapshotter: FileSnapshotter;
  private correlator: SessionCorrelator;
  private store: SessionStore;

  // Delta-based components
  private deltaWriter: DeltaWriter | null = null;
  private metricsSyncStateManager: MetricsSyncStateManager | null = null;
  private fileWatcher: ReturnType<typeof watch> | null = null;
  private discoveryInterval: NodeJS.Timeout | null = null;

  private beforeSnapshot: FileSnapshot | null = null;
  private session: Session | null = null;
  private isCollecting: boolean = false;

  constructor(options: SessionOrchestratorOptions) {
    this.sessionId = options.sessionId || randomUUID();
    this.agentName = options.agentName;
    this.provider = options.provider;
    this.project = options.project;
    this.workingDirectory = options.workingDirectory;
    this.metricsAdapter = options.metricsAdapter;
    this.lifecycleAdapter = options.lifecycleAdapter;
    this.onSessionTransition = options.onSessionTransition;

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
   * Note: This method is only called when metrics are enabled
   */
  async beforeAgentSpawn(): Promise<void> {
    try {
      // Get agent data paths
      const { sessionsDir } = this.metricsAdapter.getDataPaths();
      logger.debug(`[SessionOrchestrator] snapshot: phase=pre_spawn dir=${sessionsDir}`);

      // Take snapshot
      this.beforeSnapshot = await this.snapshotter.snapshot(sessionsDir);
      logger.debug(`[SessionOrchestrator] snapshot: phase=pre_spawn files=${this.beforeSnapshot.files.length}`);

      // Detect git branch from working directory
      const gitBranch = await detectGitBranch(this.workingDirectory);

      // Create session record
      this.session = {
        sessionId: this.sessionId,
        agentName: this.agentName,
        provider: this.provider,
        ...(this.project && { project: this.project }),
        startTime: Date.now(),
        workingDirectory: this.workingDirectory,
        ...(gitBranch && { gitBranch }), // Include branch if detected
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
      logger.info(`[SessionOrchestrator] session_created: id=${this.sessionId} agent=${this.agentName} provider=${this.provider}`);

    } catch (error) {
      // Disable metrics for the rest of the session to prevent log pollution
      process.env.CODEMIE_METRICS_DISABLED = '1';

      // Create comprehensive error context for logging
      const errorContext = createErrorContext(error, {
        sessionId: this.sessionId,
        agent: this.agentName,
        provider: this.provider,
        ...(this.project && { model: this.project })
      });

      logger.error(
        '[SessionOrchestrator] Failed to take pre-spawn snapshot',
        formatErrorForLog(errorContext)
      );

      // Store raw error for display to user (not ErrorContext)
      if (this.session) {
        (this.session as any).initError = error;
      }

      // Don't throw - metrics failures shouldn't break agent execution
    }
  }

  /**
   * Step 2: Take snapshot after agent spawn + correlate
   * Called after spawning the agent process
   * Note: This method is only called when metrics are enabled
   */
  async afterAgentSpawn(): Promise<void> {
    if (!this.isEnabled() || !this.beforeSnapshot || !this.session) {
      return;
    }

    try {
      // Wait for agent to initialize and create session file
      const initDelay = this.metricsAdapter.getInitDelay();
      const { sessionsDir } = this.metricsAdapter.getDataPaths();
      logger.debug(`[SessionOrchestrator] snapshot: phase=post_spawn delay=${initDelay}ms dir=${sessionsDir}`);

      await this.sleep(initDelay);

      // Take snapshot
      const afterSnapshot = await this.snapshotter.snapshot(sessionsDir);
      logger.debug(`[SessionOrchestrator] snapshot: phase=post_spawn pre=${this.beforeSnapshot.files.length} post=${afterSnapshot.files.length}`);

      // Compute diff
      const newFiles = this.snapshotter.diff(this.beforeSnapshot, afterSnapshot);
      logger.debug(`[SessionOrchestrator] diff: new_files=${newFiles.length}`);

      // Correlate with retry
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
        logger.info(`[SessionOrchestrator] correlation: status=matched session_id=${correlation.agentSessionId} retries=${correlation.retryCount}`);

        // Start incremental delta monitoring
        await this.startIncrementalMonitoring(correlation.agentSessionFile!);
      } else {
        logger.warn(`[SessionOrchestrator] correlation: status=failed retries=${correlation.retryCount}`);
      }

    } catch (error) {
      // Create comprehensive error context for logging
      const errorContext = createErrorContext(error, {
        sessionId: this.sessionId,
        agent: this.agentName,
        provider: this.provider,
        ...(this.project && { model: this.project })
      });

      logger.error(
        '[SessionOrchestrator] Failed in post-spawn phase',
        formatErrorForLog(errorContext)
      );

      // Store raw error for display to user (not ErrorContext)
      if (this.session) {
        (this.session as any).postSpawnError = error;
      }

      // Don't throw - metrics failures shouldn't break agent execution
    }
  }

  /**
   * Prepare session for exit (Phase 1)
   * Called when agent process exits - stops monitoring and collects final deltas
   * Note: Does NOT mark session as completed - use markSessionComplete() after sync
   */
  async prepareForExit(): Promise<void> {
    if (!this.isEnabled() || !this.session) {
      return;
    }

    try {
      logger.debug('[SessionOrchestrator] Preparing session for exit...');

      // Stop discovery interval
      if (this.discoveryInterval) {
        clearInterval(this.discoveryInterval);
        this.discoveryInterval = null;
        logger.debug('[SessionOrchestrator] Stopped discovery interval');
      }

      // Stop file watcher
      if (this.fileWatcher) {
        this.fileWatcher.close();
        this.fileWatcher = null;
        logger.debug('[SessionOrchestrator] Stopped file watcher');
      }

      // Collect final deltas
      if (this.session.correlation.status === 'matched' &&
          this.session.correlation.agentSessionFile) {
        await this.collectDeltas(this.session.correlation.agentSessionFile);
        logger.debug('[SessionOrchestrator] Collected final deltas');
      }

      logger.debug('[SessionOrchestrator] Session prepared for exit (awaiting sync completion)');

    } catch (error) {
      // Create comprehensive error context for logging
      const errorContext = createErrorContext(error, {
        sessionId: this.sessionId,
        agent: this.agentName,
        provider: this.provider,
        ...(this.project && { model: this.project })
      });

      logger.error(
        '[SessionOrchestrator] Failed to prepare session for exit',
        formatErrorForLog(errorContext)
      );

      // Don't throw - metrics failures shouldn't break agent execution
    }
  }

  /**
   * Mark session as completed (Phase 2)
   * Called AFTER final sync completes
   * Note: This should be called after proxy cleanup/sync to ensure all data is synced
   */
  async markSessionComplete(exitCode: number): Promise<void> {
    if (!this.isEnabled() || !this.session) {
      return;
    }

    try {
      // Update session status
      const status = exitCode === 0 ? 'completed' : 'failed';
      await this.store.updateSessionStatus(this.sessionId, status);

      logger.info(`[SessionOrchestrator] Session marked as ${status}`);

    } catch (error) {
      // Create comprehensive error context for logging
      const errorContext = createErrorContext(error, {
        sessionId: this.sessionId,
        agent: this.agentName,
        provider: this.provider,
        ...(this.project && { model: this.project })
      });

      logger.error(
        '[SessionOrchestrator] Failed to mark session complete',
        formatErrorForLog(errorContext)
      );

      // Don't throw - metrics failures shouldn't break agent execution
    }
  }

  /**
   * Finalize session on agent exit (Backward compatibility wrapper)
   * Called when agent process exits
   * Note: This method is kept for backward compatibility
   * @deprecated Use prepareForExit() + markSessionComplete() for proper sync ordering
   */
  async onAgentExit(exitCode: number): Promise<void> {
    await this.prepareForExit();
    await this.markSessionComplete(exitCode);
  }

  /**
   * Start incremental monitoring with delta collection
   */
  private async startIncrementalMonitoring(sessionFilePath: string): Promise<void> {
    if (!this.isEnabled() || !this.session || !this.session.correlation.agentSessionId) {
      return;
    }

    try {
      // Initialize delta writer and metrics sync state manager
      this.deltaWriter = new DeltaWriter(this.sessionId);
      this.metricsSyncStateManager = new MetricsSyncStateManager(this.sessionId);

      // Initialize metrics sync state
      await this.metricsSyncStateManager.initialize();

      logger.info('[SessionOrchestrator] Monitoring session activity in real-time');
      logger.debug('[SessionOrchestrator] Initialized delta-based metrics tracking');

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

      logger.debug('[SessionOrchestrator] Started file watching for incremental metrics');

      // Start periodic discovery for session lifecycle events (30s interval)
      if (this.lifecycleAdapter) {
        const DISCOVERY_INTERVAL = 30000; // 30 seconds
        this.discoveryInterval = setInterval(() => {
          void this.discoverNewSessions();
        }, DISCOVERY_INTERVAL);
        logger.debug('[SessionOrchestrator] Started periodic session lifecycle discovery');
      }

    } catch (error) {
      logger.error('[SessionOrchestrator] Failed to start incremental monitoring:', error);
    }
  }

  /**
   * Collect delta metrics from agent session file
   */
  private async collectDeltas(sessionFilePath: string): Promise<void> {
    // Prevent concurrent collection or if metrics disabled
    if (!this.isEnabled() || this.isCollecting || !this.deltaWriter || !this.metricsSyncStateManager) {
      return;
    }

    this.isCollecting = true;

    try {
      // Load current sync state
      const syncState = await this.metricsSyncStateManager.load();

      // If sync state doesn't exist (file deleted or not initialized yet), skip collection
      if (!syncState) {
        logger.debug('[SessionOrchestrator] Sync state not available, skipping delta collection');
        this.isCollecting = false;
        return;
      }

      // Get already-processed record IDs from sync state
      const processedRecordIds = new Set(syncState.processedRecordIds);

      // Get already-attached user prompt texts from sync state
      const attachedUserPromptTexts = new Set(syncState.attachedUserPromptTexts || []);

      // Parse incremental metrics with processed record IDs and attached prompts
      logger.info(`[SessionOrchestrator] Scanning session for new activity...`);
      const { deltas, lastLine, newlyAttachedPrompts } = await this.metricsAdapter.parseIncrementalMetrics(
        sessionFilePath,
        processedRecordIds,
        attachedUserPromptTexts
      );

      if (deltas.length === 0) {
        logger.debug('[SessionOrchestrator] No new deltas to collect');
        this.isCollecting = false;
        return;
      }

      logger.info(`[SessionOrchestrator] Found ${deltas.length} new interaction${deltas.length !== 1 ? 's' : ''} to record`);

      // Collect record IDs for tracking
      const newRecordIds: string[] = [];

      // Calculate summary statistics for logging
      let totalTokens = 0;
      let totalTools = 0;
      let totalFiles = 0;

      // Append each delta to JSONL
      for (const delta of deltas) {
        // Set CodeMie session ID
        delta.sessionId = this.sessionId;

        // Set gitBranch if not already present in delta
        if (!delta.gitBranch) {
          delta.gitBranch = await detectGitBranch(this.workingDirectory);
        }

        // Accumulate statistics
        if (delta.tokens) {
          totalTokens += (delta.tokens.input || 0) + (delta.tokens.output || 0);
        }
        if (delta.tools) {
          totalTools += Object.values(delta.tools).reduce((sum, count) => sum + count, 0);
        }
        if (delta.fileOperations) {
          totalFiles += delta.fileOperations.length;
        }

        // Append to JSONL
        await this.deltaWriter.appendDelta(delta);
        newRecordIds.push(delta.recordId);
      }

      // Update sync state with processed record IDs
      await this.metricsSyncStateManager.addProcessedRecords(newRecordIds);
      await this.metricsSyncStateManager.updateLastProcessed(lastLine, Date.now());
      await this.metricsSyncStateManager.incrementDeltas(deltas.length);

      // Update sync state with newly attached user prompts
      if (newlyAttachedPrompts && newlyAttachedPrompts.length > 0) {
        await this.metricsSyncStateManager.addAttachedUserPrompts(newlyAttachedPrompts);
      }

      // Log summary with meaningful statistics
      const parts: string[] = [];
      if (totalTokens > 0) parts.push(`${totalTokens.toLocaleString()} tokens`);
      if (totalTools > 0) parts.push(`${totalTools} tool${totalTools !== 1 ? 's' : ''}`);
      if (totalFiles > 0) parts.push(`${totalFiles} file${totalFiles !== 1 ? 's' : ''}`);

      const summary = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      logger.info(`[SessionOrchestrator] Recorded${summary}`);
      logger.debug(`[SessionOrchestrator] Processed up to line ${lastLine}`);

    } catch (error) {
      // Create comprehensive error context for logging
      const errorContext = createErrorContext(error, {
        sessionId: this.sessionId,
        agent: this.agentName,
        provider: this.provider,
        ...(this.project && { model: this.project })
      });

      logger.error(
        '[SessionOrchestrator] Failed to collect deltas',
        formatErrorForLog(errorContext)
      );
    } finally {
      this.isCollecting = false;
    }
  }

  /**
   * Get initialization errors for display to user
   * Returns the first error that occurred during metrics initialization
   */
  getInitializationError(): unknown | null {
    if (!this.session) {
      return null;
    }

    // Check for errors in order of occurrence
    const sessionWithErrors = this.session as any;
    return sessionWithErrors.initError || sessionWithErrors.postSpawnError || null;
  }

  /**
   * Check if metrics initialization had any errors
   */
  hasInitializationError(): boolean {
    return this.getInitializationError() !== null;
  }

  /**
   * Periodic discovery loop for session lifecycle events
   * Checks for session end and triggers transitions
   */
  private async discoverNewSessions(): Promise<void> {
    if (!this.isEnabled() || !this.session) {
      return;
    }

    try {
      // Check for session end
      if (this.lifecycleAdapter && this.session.correlation.status === 'matched') {
        const sessionEndTimestamp = await this.lifecycleAdapter.detectSessionEnd(
          this.session.correlation.agentSessionId!,
          this.session.startTime
        );

        if (sessionEndTimestamp) {
          logger.info(`[SessionOrchestrator] Session end detected at ${sessionEndTimestamp}`);
          await this.handleSessionTransition(sessionEndTimestamp);
          return; // Stop monitoring current session
        }
      }

      // Future: Add file discovery logic for new sessions here if needed
    } catch (error) {
      logger.error('[SessionOrchestrator] Discovery failed:', error);
    }
  }

  /**
   * Handle session transition: finalize current, create new
   */
  private async handleSessionTransition(transitionTimestamp: number): Promise<void> {
    logger.info('[SessionOrchestrator] Finalizing current session');

    // 1. Finalize current session
    await this.prepareForExit();
    await this.markSessionComplete(0);

    // 2. Find new session file in SAME directory
    const currentFile = this.session!.correlation.agentSessionFile!;
    const { dirname, basename } = await import('path');
    const currentDir = dirname(currentFile);

    logger.debug(`[SessionOrchestrator] Scanning: ${currentDir}`);

    const snapshot = await this.snapshotter.snapshot(currentDir);

    // Filter: created after transition, exclude current, match pattern
    const newFiles = snapshot.files.filter(f =>
      f.modifiedAt > transitionTimestamp + 2000 && // 2s buffer
      f.path !== currentFile &&
      this.metricsAdapter.matchesSessionPattern(f.path)
    );

    if (newFiles.length === 0) {
      logger.info('[SessionOrchestrator] No new session file found');
      return;
    }

    // Take earliest new file
    newFiles.sort((a, b) => a.modifiedAt - b.modifiedAt);
    const newSessionFile = newFiles[0];

    logger.info(`[SessionOrchestrator] New session: ${basename(newSessionFile.path)}`);

    // 3. Invoke transition callback if provided
    if (this.onSessionTransition) {
      try {
        await this.onSessionTransition({
          oldSessionId: this.sessionId,
          newSessionFile: newSessionFile.path,
          transitionTimestamp
        });
      } catch (error) {
        logger.error('[SessionOrchestrator] Session transition callback failed:', error);
      }
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
