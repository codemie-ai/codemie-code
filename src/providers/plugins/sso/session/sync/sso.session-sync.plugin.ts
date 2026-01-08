/**
 * SSO Session Sync Plugin (Unified)
 * Priority: 100 (replaces metrics and conversations sync plugins)
 *
 * Purpose: Unified orchestrator that syncs session data via multiple processors
 * - Runs only in SSO mode (ai-run-sso provider)
 * - Background timer (every 5 minutes)
 * - Discovers session files once via adapter
 * - Passes parsed sessions to all processors (metrics, conversations)
 * - Tracks processed sessions in unified store
 * - Final sync on proxy shutdown
 *
 * Architecture Benefits:
 * - Zero duplication: Sessions read once, processed multiple times
 * - Pluggable: Add processors without modifying plugin
 * - Agent-agnostic: Supports Claude, Codex, Gemini via adapters
 * - Reusable: Shared utilities for discovery and I/O
 *
 * SOLID: Single responsibility = orchestrate session sync across processors
 * KISS: Simple timer-based sync with pluggable processors
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from '../../proxy/plugins/types.js';
import { logger } from '../../../../../utils/logger.js';
import type { SessionAdapter } from '../adapters/base/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../processors/base/BaseProcessor.js';
import { MetricsProcessor } from '../processors/metrics/metrics-processor.js';
import { ConversationsProcessor } from '../processors/conversations/conversation-processor.js';
import { discoverSessionFiles } from '../utils/session-discovery.js';

export class SSOSessionSyncPlugin implements ProxyPlugin {
  id = '@codemie/sso-session-sync';
  name = 'SSO Session Sync (Unified)';
  version = '1.0.0';
  priority = 100; // Run after logging (priority 50)

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    // Only create interceptor if we have necessary context
    if (!context.config.sessionId) {
      logger.debug('[SSOSessionSyncPlugin] Skipping: Session ID not available');
      throw new Error('Session ID not available (session sync disabled)');
    }

    if (!context.credentials) {
      logger.debug('[SSOSessionSyncPlugin] Skipping: SSO credentials not available');
      throw new Error('SSO credentials not available (session sync disabled)');
    }

    if (!context.config.clientType) {
      logger.debug('[SSOSessionSyncPlugin] Skipping: Client type not available');
      throw new Error('Client type not available (session sync disabled)');
    }

    // Check if sync is enabled (from config or env var)
    const syncEnabled = this.isSyncEnabled(context);
    if (!syncEnabled) {
      logger.debug('[SSOSessionSyncPlugin] Skipping: Session sync disabled by configuration');
      throw new Error('Session sync disabled by configuration');
    }

    logger.debug('[SSOSessionSyncPlugin] Initializing unified session sync');

    // Check if dry-run mode is enabled
    const dryRun = this.isDryRunEnabled(context);

    return new SSOSessionSyncInterceptor(
      context.config.sessionId,
      context.config.targetApiUrl,
      context.credentials.cookies,
      context.config.clientType,
      context.config.version,
      dryRun
    );
  }

  /**
   * Check if session sync is enabled
   * Priority: ENV > Profile config > Default (true)
   */
  private isSyncEnabled(context: PluginContext): boolean {
    // Check environment variable first
    const envEnabled = process.env.CODEMIE_SESSION_SYNC_ENABLED;
    if (envEnabled !== undefined) {
      return envEnabled === 'true' || envEnabled === '1';
    }

    // Check profile config (if available)
    const profileConfig = context.profileConfig as any;
    if (profileConfig?.session?.sync?.enabled !== undefined) {
      return profileConfig.session.sync.enabled;
    }

    // Default to enabled for SSO mode
    return true;
  }

  /**
   * Check if dry-run mode is enabled
   * Priority: ENV > Profile config > Default (false)
   */
  private isDryRunEnabled(context: PluginContext): boolean {
    // Check environment variable first
    const envDryRun = process.env.CODEMIE_SESSION_DRY_RUN;
    if (envDryRun !== undefined) {
      return envDryRun === 'true' || envDryRun === '1';
    }

    // Check profile config (if available)
    const profileConfig = context.profileConfig as any;
    if (profileConfig?.session?.sync?.dryRun !== undefined) {
      return profileConfig.session.sync.dryRun;
    }

    // Default to disabled
    return false;
  }
}

class SSOSessionSyncInterceptor implements ProxyInterceptor {
  name = 'sso-session-sync';

  private syncTimer?: NodeJS.Timeout;
  private adapter?: SessionAdapter;
  private processors: SessionProcessor[];
  private context: ProcessingContext;
  private syncInterval: number;
  private isSyncing = false;
  private agentName: string;

  constructor(
    private sessionId: string,
    baseUrl: string,
    cookies: Record<string, string>,
    clientType: string,
    version: string = '0.0.0',
    dryRun: boolean = false
  ) {
    // Extract agent name from clientType (e.g., 'codemie-claude' → 'claude')
    this.agentName = clientType.replace(/^codemie-/, '');

    if (dryRun) {
      logger.info('[sso-session-sync] Dry-run mode enabled - sessions will be logged but not sent');
    }

    // Build cookie header
    const cookieHeader = Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');

    // Create processing context (shared by all processors)
    this.context = {
      apiBaseUrl: baseUrl,
      cookies: cookieHeader,
      clientType,
      version,
      dryRun
    };

    // Initialize processors (sorted by priority)
    this.processors = [
      new MetricsProcessor(),
      new ConversationsProcessor()
    ].sort((a, b) => a.priority - b.priority);

    // Get sync interval from env or default to 5 minutes
    this.syncInterval = Number.parseInt(
      process.env.CODEMIE_SESSION_SYNC_INTERVAL || '300000',
      10
    );
  }

  /**
   * Called when proxy starts - initialize adapter and background timer
   */
  async onProxyStart(): Promise<void> {
    // Get agent from registry
    const { AgentRegistry } = await import('../../../../../agents/registry.js');
    const agent = AgentRegistry.getAgent(this.agentName);

    if (!agent) {
      logger.error(`[${this.name}] Agent not found in registry: ${this.agentName}`);
      throw new Error(`Agent not found: ${this.agentName}`);
    }

    // Get session adapter from agent plugin
    // @ts-expect-error - getSessionAdapter is optional and not in base interface
    if (typeof agent.getSessionAdapter !== 'function') {
      logger.error(`[${this.name}] Agent does not support session adapter: ${this.agentName}`);
      throw new Error(`Agent ${this.agentName} does not support session sync`);
    }

    // @ts-expect-error - getSessionAdapter is optional and not in base interface
    this.adapter = agent.getSessionAdapter();

    const intervalMinutes = Math.round(this.syncInterval / 60000);
    logger.info(`[${this.name}] Session sync enabled - syncing every ${intervalMinutes} minute${intervalMinutes !== 1 ? 's' : ''}`);
    logger.debug(`[${this.name}] Processors registered: ${this.processors.map(p => `${p.name}(p${p.priority})`).join(', ')}`);

    // Start background timer
    this.syncTimer = setInterval(() => {
      this.syncSessions().catch(error => {
        logger.error(`[${this.name}] Sync failed:`, error);
      });
    }, this.syncInterval);

    logger.debug(`[${this.name}] Background timer started`);
  }

  /**
   * Called when proxy stops - cleanup and final sync
   */
  async onProxyStop(): Promise<void> {
    logger.debug(`[${this.name}] Stopping session sync`);

    // Stop timer
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }

    // Final sync (ensure all sessions are processed)
    try {
      await this.syncSessions();
      logger.info(`[${this.name}] Session data saved`);
    } catch (error) {
      logger.error(`[${this.name}] Final sync failed:`, error);
    }
  }

  /**
   * Sync sessions to API via all processors
   */
  private async syncSessions(): Promise<void> {
    // Skip if already syncing (prevent concurrent syncs)
    if (this.isSyncing) {
      logger.debug(`[${this.name}] Sync already in progress, skipping`);
      return;
    }

    if (!this.adapter) {
      logger.error(`[${this.name}] Adapter not initialized`);
      return;
    }

    this.isSyncing = true;

    try {
      // 1. Discover session files via adapter
      const sessionFiles = await discoverSessionFiles(this.adapter);

      if (sessionFiles.length === 0) {
        logger.debug(`[${this.name}] No session files found`);
        return;
      }

      // 2. Process ALL sessions - processors handle their own incremental logic (Phase 4.1)
      logger.info(`[${this.name}] Found ${sessionFiles.length} session file${sessionFiles.length !== 1 ? 's' : ''} to process`);

      // 3. Process each session
      for (const sessionFile of sessionFiles) {
        try {
          await this.processSession(sessionFile);
        } catch (error: any) {
          logger.error(`[${this.name}] Failed to process ${sessionFile}:`, error.message);
          // Continue with other sessions even if one fails
        }
      }

    } catch (error) {
      logger.error(`[${this.name}] Sync failed:`, error);
      throw error;

    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Process a single session file through all processors
   */
  private async processSession(sessionFile: string): Promise<void> {
    if (!this.adapter) {
      throw new Error('Adapter not initialized');
    }

    // Parse session file via adapter (agent-specific parsing)
    const session = await this.adapter.parseSessionFile(sessionFile);

    logger.debug(`[${this.name}] Processing session ${session.sessionId} from ${sessionFile}`);

    // Track results from each processor
    const results: Record<string, ProcessingResult> = {};

    // Run through all processors
    for (const processor of this.processors) {
      try {
        // Check if processor should run for this session
        if (!processor.shouldProcess(session)) {
          logger.debug(`[${this.name}] Processor ${processor.name} skipped (shouldProcess=false)`);
          continue;
        }

        logger.debug(`[${this.name}] Running processor: ${processor.name} (priority ${processor.priority})`);

        // Process session
        const result = await processor.process(session, this.context);
        results[processor.name] = result;

        if (result.success) {
          logger.debug(`[${this.name}] Processor ${processor.name} succeeded: ${result.message || 'OK'}`);
        } else {
          logger.error(`[${this.name}] Processor ${processor.name} failed: ${result.message}`);
        }

      } catch (error: any) {
        logger.error(`[${this.name}] Processor ${processor.name} threw error:`, error);
        results[processor.name] = {
          success: false,
          message: error.message || 'Unknown error'
        };
      }
    }

    // Phase 4.1: No session-level tracking - processors handle their own incremental logic
    const successCount = Object.values(results).filter(r => r.success).length;
    const totalCount = Object.keys(results).length;

    logger.info(
      `[${this.name}] Processed session ${session.sessionId} (${successCount}/${totalCount} processors succeeded)`
    );
  }
}
