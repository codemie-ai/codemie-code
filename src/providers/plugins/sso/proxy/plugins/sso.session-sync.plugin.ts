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

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { logger } from '../../../../../utils/logger.js';
import type { ProcessingContext } from '../../session/BaseProcessor.js';
import { SessionSyncer } from '../../session/SessionSyncer.js';

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
  private syncer: SessionSyncer;
  private context: ProcessingContext;
  private syncInterval: number;
  private isSyncing = false;

  constructor(
    private sessionId: string,
    baseUrl: string,
    cookies: Record<string, string>,
    clientType: string,
    version: string = '0.0.0',
    dryRun: boolean = false
  ) {
    if (dryRun) {
      logger.info('[sso-session-sync] Dry-run mode enabled - sessions will be logged but not sent');
    }

    // Check for localhost development override
    const devApiUrl = process.env.CODEMIE_DEV_API_URL;
    const devApiKey = process.env.CODEMIE_DEV_API_KEY;

    // Use dev settings if both are provided
    const isLocalDev = !!devApiUrl && !!devApiKey;

    if (isLocalDev) {
      logger.info(`[sso-session-sync] Local development mode: using ${devApiUrl} with user-id header`);
    }

    // Build cookie header (only if not in local dev mode)
    const cookieHeader = isLocalDev ? '' : Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');

    // Create processing context (shared by SessionSyncer)
    this.context = {
      apiBaseUrl: isLocalDev ? devApiUrl : baseUrl,
      cookies: cookieHeader,
      apiKey: isLocalDev ? devApiKey : undefined,
      clientType,
      version,
      dryRun
    };

    // Initialize SessionSyncer
    this.syncer = new SessionSyncer();

    // Get sync interval from env or default to 2 minutes
    this.syncInterval = Number.parseInt(
      process.env.CODEMIE_SESSION_SYNC_INTERVAL || '120000',
      10
    );
  }

  /**
   * Called when proxy starts - initialize background timer
   */
  async onProxyStart(): Promise<void> {
    const intervalMinutes = Math.round(this.syncInterval / 60000);
    logger.info(`[${this.name}] Session sync enabled - syncing every ${intervalMinutes} minute${intervalMinutes !== 1 ? 's' : ''}`);

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
    // This syncs BOTH metrics and conversations
    try {
      logger.info(`[${this.name}] sync: phase=final session_id=${this.sessionId}`);
      await this.syncSessions();
      logger.info(`[${this.name}] sync: phase=final status=success session_id=${this.sessionId}`);
    } catch (error) {
      logger.error(`[${this.name}] sync: phase=final status=error session_id=${this.sessionId}`, error);
    }
  }

  /**
   * Sync sessions to API using SessionSyncer
   */
  private async syncSessions(): Promise<void> {
    // Skip if already syncing (prevent concurrent syncs)
    if (this.isSyncing) {
      logger.debug(`[${this.name}] Sync already in progress, skipping`);
      return;
    }

    this.isSyncing = true;

    try {
      logger.debug(`[${this.name}] Starting sync for session ${this.sessionId}`);

      // Use SessionSyncer service
      const result = await this.syncer.sync(this.sessionId, this.context);

      if (result.success) {
        logger.info(`[${this.name}] ${result.message}`);
      } else {
        logger.warn(`[${this.name}] Sync had failures: ${result.message}`);
      }

    } catch (error) {
      logger.error(`[${this.name}] Sync failed:`, error);
    } finally {
      this.isSyncing = false;
    }
  }

}
