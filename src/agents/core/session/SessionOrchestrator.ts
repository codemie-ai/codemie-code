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
import type { Session, FileSnapshot, FileInfo, SessionLifecycleAdapter } from './types.js';
import type { AgentMetricsSupport } from '../metrics/types.js';
import { METRICS_CONFIG } from '../metrics-config.js';
import { logger } from '../../../utils/logger.js';
import { watch } from 'fs';
import { detectGitBranch } from '../../../utils/processes.js';
import { createErrorContext, formatErrorForLog } from '../../../utils/errors.js';

export interface SessionTransitionEvent {
  oldSessionId: string; // OLD agent session ID (e.g., 344a4572) for END metrics
  newSessionFile: string; // NEW agent session file path
  transitionTimestamp: number; // When /clear was executed
  newOrchestrator: SessionOrchestrator; // New orchestrator instance for replacement
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
  onLifecycleEvent?: (event: 'sessionStart' | 'sessionEnd', data: any) => Promise<void>; // Optional: callback for lifecycle events
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
  private onLifecycleEvent?: (event: 'sessionStart' | 'sessionEnd', data: any) => Promise<void>;

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
    this.onLifecycleEvent = options.onLifecycleEvent;

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
      logger.info('[SessionOrchestrator] Preparing to track session metrics...');

      // Get agent data paths
      const { sessionsDir } = this.metricsAdapter.getDataPaths();
      logger.debug(`[SessionOrchestrator] Taking pre-spawn snapshot of: ${sessionsDir}`);

      // Take snapshot
      this.beforeSnapshot = await this.snapshotter.snapshot(sessionsDir);

      logger.info(`[SessionOrchestrator] Baseline: ${this.beforeSnapshot.files.length} existing session file${this.beforeSnapshot.files.length !== 1 ? 's' : ''}`);
      logger.debug(`[SessionOrchestrator] Pre-spawn snapshot complete: ${this.beforeSnapshot.files.length} files`);

      // Show sample of baseline files for debugging
      if (this.beforeSnapshot.files.length > 0) {
        const sampleSize = Math.min(3, this.beforeSnapshot.files.length);
        const sample = this.beforeSnapshot.files.slice(0, sampleSize).map(f => f.path);
        logger.info(`[SessionOrchestrator] Sample files (first ${sampleSize}):`);
        for (const filePath of sample) {
          logger.info(`[SessionOrchestrator]    → ${filePath}`);
        }
        if (this.beforeSnapshot.files.length > sampleSize) {
          logger.info(`[SessionOrchestrator]    ... and ${this.beforeSnapshot.files.length - sampleSize} more`);
        }
      }

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
      logger.info(`[SessionOrchestrator] Session created: ${this.sessionId}`);
      logger.debug(`[SessionOrchestrator] Agent: ${this.agentName}, Provider: ${this.provider}`);

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
      logger.info(`[SessionOrchestrator] Agent started - waiting for session file creation...`);

      // Wait for agent to initialize and create session file
      const initDelay = this.metricsAdapter.getInitDelay();
      await this.sleep(initDelay);

      // Get agent data paths
      const { sessionsDir } = this.metricsAdapter.getDataPaths();
      logger.info(`[SessionOrchestrator] Scanning directory: ${sessionsDir}`);

      // Take snapshot
      const afterSnapshot = await this.snapshotter.snapshot(sessionsDir);
      logger.info(`[SessionOrchestrator] Found ${afterSnapshot.files.length} total session file${afterSnapshot.files.length !== 1 ? 's' : ''} in directory`);
      logger.debug(`[SessionOrchestrator] Pre-spawn: ${this.beforeSnapshot.files.length} files, Post-spawn: ${afterSnapshot.files.length} files`);

      // Show sample of post-spawn files for comparison
      if (afterSnapshot.files.length > 0 && afterSnapshot.files.length !== this.beforeSnapshot.files.length) {
        const sampleSize = Math.min(3, afterSnapshot.files.length);
        const sample = afterSnapshot.files.slice(0, sampleSize).map(f => f.path);
        logger.info(`[SessionOrchestrator] Post-spawn files (first ${sampleSize}):`);
        for (const filePath of sample) {
          logger.info(`[SessionOrchestrator]    → ${filePath}`);
        }
        if (afterSnapshot.files.length > sampleSize) {
          logger.info(`[SessionOrchestrator]    ... and ${afterSnapshot.files.length - sampleSize} more`);
        }
      }

      // Compute diff
      const newFiles = this.snapshotter.diff(this.beforeSnapshot, afterSnapshot);
      if (newFiles.length > 0) {
        logger.info(`[SessionOrchestrator] ${newFiles.length} new file${newFiles.length !== 1 ? 's' : ''} created since agent start`);
        // Use path.basename for cross-platform display
        const { basename } = await import('path');
        logger.info(`[SessionOrchestrator]    ${newFiles.map(f => `→ ${basename(f.path)}`).join(', ')}`);
        logger.debug(`[SessionOrchestrator] New files (full paths): ${newFiles.map(f => f.path).join(', ')}`);
      } else {
        logger.info(`[SessionOrchestrator] No new files yet - will retry...`);
        logger.debug(`[SessionOrchestrator] Diff result: 0 new files (baseline had ${this.beforeSnapshot.files.length}, post-spawn has ${afterSnapshot.files.length})`);
      }

      // Correlate with retry
      logger.debug('[SessionOrchestrator] Starting correlation with retry...');
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
        logger.debug(`[SessionOrchestrator] Session correlated: ${correlation.agentSessionId}`);
        logger.debug(`[SessionOrchestrator]   Agent file: ${correlation.agentSessionFile}`);
        logger.debug(`[SessionOrchestrator]   Retry count: ${correlation.retryCount}`);

        // Start incremental delta monitoring
        await this.startIncrementalMonitoring(correlation.agentSessionFile!);
      } else {
        logger.warn(`[SessionOrchestrator] Correlation failed after ${correlation.retryCount} retries`);
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
   * End session with full stop flow
   * Provides hooks for lifecycle callbacks to be injected by caller
   * Reusable by both normal exit and transition flows
   */
  async endSession(
    exitCode: number,
    options?: {
      beforeCleanup?: () => Promise<void>;
      cleanup?: () => Promise<void>;
    }
  ): Promise<void> {
    // Phase 1: Collect final deltas and stop monitoring
    logger.info('[SessionOrchestrator] Ending session - collecting final metrics');
    await this.prepareForExit();

    // Phase 2: Allow caller to inject lifecycle hooks (e.g., onSessionEnd)
    if (options?.beforeCleanup) {
      logger.debug('[SessionOrchestrator] Executing beforeCleanup callback');
      await options.beforeCleanup();
    }

    // Phase 3: Trigger immediate sync (if cleanup provided)
    if (options?.cleanup) {
      logger.debug('[SessionOrchestrator] Executing cleanup callback');
      await options.cleanup();
    }

    // Phase 4: Mark session as completed
    logger.info('[SessionOrchestrator] Marking session complete');
    await this.markSessionComplete(exitCode);
  }

  /**
   * Destroy orchestrator and clean up resources
   * Called before replacing orchestrator during transition
   */
  async destroy(): Promise<void> {
    logger.info('[SessionOrchestrator] Destroying orchestrator');

    // Stop file watcher if active
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
      logger.debug('[SessionOrchestrator] Closed file watcher');
    }

    // Clear discovery interval
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
      logger.debug('[SessionOrchestrator] Cleared discovery interval');
    }

    logger.debug('[SessionOrchestrator] Orchestrator destroyed');
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
        logger.info('[SessionOrchestrator] Periodic discovery enabled (checking every 30s for session end)');
      } else {
        logger.warn('[SessionOrchestrator] No lifecycle adapter - session transitions disabled');
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
   * Get current session metadata
   */
  getSession(): Session {
    if (!this.session) {
      throw new Error('Session not initialized');
    }
    return this.session;
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
        logger.debug(`[SessionOrchestrator] Checking for session end (agentSessionId=${this.session.correlation.agentSessionId})`);

        const sessionEndTimestamp = await this.lifecycleAdapter.detectSessionEnd(
          this.session.correlation.agentSessionId!,
          this.session.startTime
        );

        if (sessionEndTimestamp) {
          logger.info(`[SessionOrchestrator] Session end detected at ${new Date(sessionEndTimestamp).toISOString()}`);

          // Execute transition with lifecycle callbacks
          const newOrchestrator = await this.handleSessionTransition(
            sessionEndTimestamp,
            {
              executeOnSessionEnd: async (exitCode: number) => {
                // Call onSessionEnd hook via callback if provided
                if (this.onLifecycleEvent) {
                  await this.onLifecycleEvent('sessionEnd', exitCode);
                }
              },
              executeOnSessionStart: async (sessionId: string) => {
                // Call onSessionStart hook via callback if provided
                if (this.onLifecycleEvent) {
                  await this.onLifecycleEvent('sessionStart', sessionId);
                }
              }
            }
          );

          // Trigger transition callback to replace orchestrator in adapter
          if (this.onSessionTransition) {
            await this.onSessionTransition({
              oldSessionId: this.session!.correlation.agentSessionId!,
              newSessionFile: newOrchestrator.getSession().correlation.agentSessionFile!,
              transitionTimestamp: sessionEndTimestamp,
              newOrchestrator
            });
          }

          return; // Stop monitoring current session
        }

        logger.debug('[SessionOrchestrator] No session end detected - continuing monitoring');
      }

      // Future: Add file discovery logic for new sessions here if needed
    } catch (error) {
      logger.error('[SessionOrchestrator] Discovery failed:', error);
    }
  }

  /**
   * Handle session transition when /clear is executed
   *
   * Follows Scenario 2 (Stop) + Scenario 1 (Start) pattern:
   * - End old session completely (with lifecycle hooks and sync)
   * - Create new session with new orchestrator
   * - Return new orchestrator for adapter to use
   */
  private async handleSessionTransition(
    transitionTimestamp: number,
    lifecycleCallbacks: {
      executeOnSessionEnd: (exitCode: number) => Promise<void>;
      executeOnSessionStart: (sessionId: string) => Promise<void>;
    }
  ): Promise<SessionOrchestrator> {
    const oldSessionFile = this.session!.correlation.agentSessionFile!;
    const oldAgentSessionId = this.session!.correlation.agentSessionId!;

    logger.info(`[SessionOrchestrator] Session transition starting: ${oldAgentSessionId} → new session`);

    // ========================================
    // STEP 1: End Old Session (Scenario 2)
    // ========================================
    const { randomUUID } = await import('crypto');
    const newSessionId = randomUUID();
    logger.info(`[SessionOrchestrator] Ending old session: ${oldAgentSessionId}`);

    // Mark old session with transition link (before ending)
    this.session!.transitionedTo = newSessionId;
    await this.store.saveSession(this.session!);

    // Use extracted endSession() method
    await this.endSession(0, {
      beforeCleanup: async () => {
        // Send END metric via standard lifecycle hook
        logger.info(`[SessionOrchestrator] Sending END metric for old session`);
        await lifecycleCallbacks.executeOnSessionEnd(0);
        logger.info(`[SessionOrchestrator] END metric sent for old session`);
      },
      cleanup: async () => {
        // Trigger immediate sync
        logger.info(`[SessionOrchestrator] Triggering final sync for old session`);
        // Note: Cleanup will be passed from BaseAgentAdapter
      }
    });

    logger.info(`[SessionOrchestrator] Old session ended and marked completed`);

    // ========================================
    // STEP 2: Start New Session (Scenario 1)
    // ========================================
    logger.info(`[SessionOrchestrator] Creating new session: ${newSessionId}`);

    // Create new orchestrator for new session
    const newOrchestrator = new SessionOrchestrator({
      sessionId: newSessionId,
      agentName: this.agentName,
      provider: this.session!.provider,
      project: this.session!.project,
      workingDirectory: this.workingDirectory,
      metricsAdapter: this.metricsAdapter,
      lifecycleAdapter: this.lifecycleAdapter,
      onSessionTransition: this.onSessionTransition // Pass same callback
    });

    // Send START metric for new session
    logger.info(`[SessionOrchestrator] Sending START metric for new session`);
    await lifecycleCallbacks.executeOnSessionStart(newSessionId);
    logger.info(`[SessionOrchestrator] START metric sent for new session`);

    // Initialize new orchestrator (baseline snapshot)
    logger.info(`[SessionOrchestrator] Initializing new orchestrator`);
    await newOrchestrator.beforeAgentSpawn();

    // Link new session back to old session
    newOrchestrator.session!.transitionedFrom = this.sessionId;
    await newOrchestrator.store.saveSession(newOrchestrator.session!);

    // Find and correlate new agent session file
    logger.info(`[SessionOrchestrator] Searching for new agent session file...`);
    logger.debug(`[SessionOrchestrator] Transition at: ${new Date(transitionTimestamp).toISOString()}`);

    // Helper function to get candidates (same as before)
    const { dirname } = await import('path');
    const currentDir = dirname(oldSessionFile);

    const getCandidates = async (): Promise<FileInfo[]> => {
      const snapshot = await newOrchestrator.snapshotter.snapshot(currentDir);

      const candidates = snapshot.files.filter(f =>
        f.createdAt >= transitionTimestamp - 200 &&
        f.path !== oldSessionFile
      );

      if (candidates.length > 0) {
        logger.debug(`[SessionOrchestrator] Found ${candidates.length} candidate(s)`);
      }

      return candidates;
    };

    // Get initial candidates
    const initialCandidates = await getCandidates();

    // Correlate new orchestrator with new agent session file
    const correlation = await newOrchestrator.correlator.correlateWithRetry(
      {
        sessionId: newSessionId,
        agentName: this.agentName,
        workingDirectory: this.workingDirectory,
        newFiles: initialCandidates,
        agentPlugin: this.metricsAdapter
      },
      getCandidates
    );

    if (correlation.status !== 'matched') {
      logger.error(`[SessionOrchestrator] Failed to find new session after ${correlation.retryCount} retries`);
      throw new Error('Failed to correlate new session after transition');
    }

    const newAgentSessionId = correlation.agentSessionId!;
    logger.info(`[SessionOrchestrator] New session correlated with agent file: ${newAgentSessionId}`);

    // Update new orchestrator's correlation
    newOrchestrator.session!.correlation = correlation;
    await newOrchestrator.store.saveSession(newOrchestrator.session!);

    // Start monitoring new agent session
    logger.info(`[SessionOrchestrator] Starting monitoring for new session`);
    await newOrchestrator.startIncrementalMonitoring(correlation.agentSessionFile!);

    // ========================================
    // STEP 3: Complete Transition
    // ========================================
    logger.info(
      `[SessionOrchestrator] ✓ Transition complete: ` +
      `${oldAgentSessionId} (${this.sessionId}) → ${newAgentSessionId} (${newSessionId})`
    );

    // Log summary
    logger.info('='.repeat(60));
    logger.info(`[SessionOrchestrator] Session Transition Summary:`);
    logger.info(`  Old CodeMie Session: ${this.sessionId}`);
    logger.info(`  Old Agent Session:   ${oldAgentSessionId}`);
    logger.info(`  New CodeMie Session: ${newSessionId}`);
    logger.info(`  New Agent Session:   ${newAgentSessionId}`);
    logger.info('='.repeat(60));

    // Return new orchestrator so caller can replace it
    return newOrchestrator;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
