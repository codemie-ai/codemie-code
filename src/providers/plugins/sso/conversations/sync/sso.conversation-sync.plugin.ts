/**
 * SSO Conversation Sync Plugin
 * Priority: 101 (runs after metrics plugin)
 *
 * Purpose: Syncs Claude conversation history to Codemie API in background (SSO provider only)
 * - Runs only in SSO mode (ai-run-sso provider)
 * - Background timer (every 5 minutes)
 * - Reads Claude session files from ~/.claude/projects/
 * - Transforms to Codemie conversation format
 * - Tracks synced sessions to avoid duplicates
 * - Final sync on proxy shutdown
 *
 * IMPORTANT: This is an SSO provider capability.
 * Only works with ai-run-sso provider which provides authentication cookies.
 *
 * SOLID: Single responsibility = sync conversations for SSO
 * KISS: Simple timer-based sync with session tracking
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from '../../proxy/plugins/types.js';
import { logger } from '../../../../../utils/logger.js';
import { ConversationApiClient } from './sso.conversation-api-client.js';
import { transformMessages } from './sso.conversation-transformer.js';
import type { ClaudeMessage } from './sso.conversation-types.js';
import { readFile, readdir, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

export class SSOConversationSyncPlugin implements ProxyPlugin {
  id = '@codemie/sso-conversation-sync';
  name = 'SSO Conversation Sync';
  version = '1.0.0';
  priority = 101; // Run after metrics sync (priority 100)

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    // Only create interceptor if we have necessary context
    if (!context.config.sessionId) {
      logger.debug('[SSOConversationSyncPlugin] Skipping: Session ID not available');
      throw new Error('Session ID not available (conversation sync disabled)');
    }

    if (!context.credentials) {
      logger.debug('[SSOConversationSyncPlugin] Skipping: SSO credentials not available');
      throw new Error('SSO credentials not available (conversation sync disabled)');
    }

    // Check if client is Claude Code
    if (context.config.clientType !== 'codemie-claude') {
      logger.debug('[SSOConversationSyncPlugin] Skipping: Only supports Claude Code agent');
      throw new Error('Not a Claude Code agent (conversation sync disabled)');
    }

    // Check if conversation sync is enabled (from config or env var)
    const syncEnabled = this.isSyncEnabled(context);
    if (!syncEnabled) {
      logger.debug('[SSOConversationSyncPlugin] Skipping: Conversation sync disabled by configuration');
      throw new Error('Conversation sync disabled by configuration');
    }

    logger.debug('[SSOConversationSyncPlugin] Initializing conversation sync');

    // Check if dry-run mode is enabled
    const dryRun = this.isDryRunEnabled(context);

    return new SSOConversationSyncInterceptor(
      context.config.sessionId,
      context.config.targetApiUrl,
      context.credentials.cookies,
      context.config.clientType,
      context.config.version,
      dryRun
    );
  }

  /**
   * Check if conversation sync is enabled
   * Priority: ENV > Profile config > Default (true)
   */
  private isSyncEnabled(context: PluginContext): boolean {
    // Check environment variable first
    const envEnabled = process.env.CODEMIE_CONVERSATION_SYNC_ENABLED;
    if (envEnabled !== undefined) {
      return envEnabled === 'true' || envEnabled === '1';
    }

    // Check profile config (if available)
    const profileConfig = context.profileConfig as any;
    if (profileConfig?.conversations?.sync?.enabled !== undefined) {
      return profileConfig.conversations.sync.enabled;
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
    const envDryRun = process.env.CODEMIE_CONVERSATION_DRY_RUN;
    if (envDryRun !== undefined) {
      return envDryRun === 'true' || envDryRun === '1';
    }

    // Check profile config (if available)
    const profileConfig = context.profileConfig as any;
    if (profileConfig?.conversations?.sync?.dryRun !== undefined) {
      return profileConfig.conversations.sync.dryRun;
    }

    // Default to disabled
    return false;
  }
}

class SSOConversationSyncInterceptor implements ProxyInterceptor {
  name = 'sso-conversation-sync';

  private syncTimer?: NodeJS.Timeout;
  private apiClient: ConversationApiClient;
  private syncInterval: number;
  private isSyncing = false;
  private version: string;
  private dryRun: boolean;
  private syncedSessionsPath: string;
  private syncedSessions: Set<string>;

  constructor(
    private sessionId: string,
    baseUrl: string,
    cookies: Record<string, string>,
    clientType?: string,
    version?: string,
    dryRun: boolean = false
  ) {
    // Get version from proxy config (passed from AgentCLI)
    this.version = version || '0.0.0';

    // Set dry-run mode (passed from plugin)
    this.dryRun = dryRun;

    if (this.dryRun) {
      logger.info('[sso-conversation-sync] Dry-run mode enabled - conversations will be logged but not sent');
    }

    // Build cookie header
    const cookieHeader = Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');

    this.apiClient = new ConversationApiClient({
      baseUrl,
      cookies: cookieHeader,
      timeout: 30000,
      retryAttempts: 3,
      version: this.version,
      clientType: clientType || 'codemie-cli',
      dryRun: this.dryRun
    });

    // Get sync interval from env or default to 5 minutes
    this.syncInterval = Number.parseInt(
      process.env.CODEMIE_CONVERSATION_SYNC_INTERVAL || '300000',
      10
    );

    // Initialize synced sessions tracking
    this.syncedSessionsPath = join(homedir(), '.codemie', 'conversations', 'synced-sessions.json');
    this.syncedSessions = new Set();
  }

  /**
   * Called when proxy starts - initialize background timer
   */
  async onProxyStart(): Promise<void> {
    const intervalMinutes = Math.round(this.syncInterval / 60000);
    logger.info(`[${this.name}] Conversation sync enabled - syncing every ${intervalMinutes} minute${intervalMinutes !== 1 ? 's' : ''}`);

    // Load synced sessions from disk
    await this.loadSyncedSessions();

    // Start background timer
    this.syncTimer = setInterval(() => {
      this.syncConversations().catch(error => {
        logger.error(`[${this.name}] Sync failed:`, error);
      });
    }, this.syncInterval);

    logger.debug(`[${this.name}] Background timer started`);
  }

  /**
   * Called when proxy stops - cleanup and final sync
   */
  async onProxyStop(): Promise<void> {
    logger.debug(`[${this.name}] Stopping conversation sync`);

    // Stop timer
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }

    // Final sync (ensure all conversations are sent)
    try {
      await this.syncConversations();
      logger.info(`[${this.name}] Conversation history saved`);
    } catch (error) {
      logger.error(`[${this.name}] Final sync failed:`, error);
    }
  }

  /**
   * Sync conversations to API
   */
  private async syncConversations(): Promise<void> {
    // Skip if already syncing (prevent concurrent syncs)
    if (this.isSyncing) {
      logger.debug(`[${this.name}] Sync already in progress, skipping`);
      return;
    }

    this.isSyncing = true;

    try {
      // Find Claude session files
      const claudeProjectsDir = join(homedir(), '.claude', 'projects');

      if (!existsSync(claudeProjectsDir)) {
        logger.debug(`[${this.name}] Claude projects directory not found: ${claudeProjectsDir}`);
        return;
      }

      // Get all project directories
      const projectDirs = await readdir(claudeProjectsDir, { withFileTypes: true });
      const sessionFiles: string[] = [];

      // Find all .jsonl session files
      for (const dir of projectDirs) {
        if (dir.isDirectory()) {
          const projectPath = join(claudeProjectsDir, dir.name);
          const files = await readdir(projectPath);

          for (const file of files) {
            // Match UUID.jsonl pattern (exclude agent-* files)
            if (file.endsWith('.jsonl') && !file.startsWith('agent-')) {
              sessionFiles.push(join(projectPath, file));
            }
          }
        }
      }

      if (sessionFiles.length === 0) {
        logger.debug(`[${this.name}] No Claude session files found`);
        return;
      }

      // Filter out already synced sessions
      const unsyncedFiles = sessionFiles.filter(file => {
        const sessionId = this.extractSessionId(file);
        return sessionId && !this.syncedSessions.has(sessionId);
      });

      if (unsyncedFiles.length === 0) {
        logger.debug(`[${this.name}] No new sessions to sync`);
        return;
      }

      logger.info(`[${this.name}] Found ${unsyncedFiles.length} new conversation${unsyncedFiles.length !== 1 ? 's' : ''} to sync`);

      // Sync each session
      for (const sessionFile of unsyncedFiles) {
        try {
          await this.syncSession(sessionFile);
        } catch (error: any) {
          logger.error(`[${this.name}] Failed to sync ${sessionFile}:`, error.message);
        }
      }

      // Save synced sessions to disk
      await this.saveSyncedSessions();

    } catch (error) {
      logger.error(`[${this.name}] Sync failed:`, error);
      throw error;

    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync a single Claude session file
   * Splits session into multiple conversations when /clear command is detected
   */
  private async syncSession(sessionFile: string): Promise<void> {
    // Read and parse session file
    const content = await readFile(sessionFile, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    if (lines.length === 0) {
      logger.debug(`[${this.name}] Session file is empty: ${sessionFile}`);
      return;
    }

    // Parse JSONL messages
    const messages: ClaudeMessage[] = [];
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        messages.push(msg);
      } catch (error) {
        logger.warn(`[${this.name}] Failed to parse line in ${sessionFile}:`, error);
      }
    }

    if (messages.length === 0) {
      logger.debug(`[${this.name}] No valid messages in ${sessionFile}`);
      return;
    }

    // Extract Claude session ID from first message (for tracking)
    const claudeSessionId = messages[0].sessionId;

    if (!claudeSessionId) {
      logger.warn(`[${this.name}] Session ID not found in ${sessionFile}`);
      return;
    }

    // Split messages into conversations by /clear command
    const conversations = this.splitConversationsByClear(messages);

    if (conversations.length === 0) {
      logger.debug(`[${this.name}] No conversations found in ${sessionFile}`);
      return;
    }

    logger.info(`[${this.name}] Found ${conversations.length} conversation(s) in Claude session ${claudeSessionId}`);

    // Sync each conversation separately
    for (let i = 0; i < conversations.length; i++) {
      const conversationMessages = conversations[i];
      const conversationId = randomUUID();

      // Transform to Codemie format with agent name
      const history = transformMessages(
        conversationMessages,
        '5a430368-9e91-4564-be20-989803bf4da2',  // assistant_id
        'Claude Code'  // agent display name
      );

      if (history.length === 0) {
        logger.debug(`[${this.name}] No history after transformation for conversation ${i + 1}`);
        continue;
      }

      logger.info(`[${this.name}] Syncing conversation ${i + 1}/${conversations.length}: ${conversationId} (${history.length} messages)`);

      // Send to API with specified assistant_id
      const response = await this.apiClient.upsertConversation(
        conversationId,
        history,
        '5a430368-9e91-4564-be20-989803bf4da2',  // Specified assistant_id
        'Claude Imports'
      );

      if (!response.success) {
        throw new Error(response.message);
      }

      logger.info(`[${this.name}] Successfully synced conversation ${conversationId} (${response.new_messages} new, ${response.total_messages} total)`);
    }

    // Mark Claude session as synced after all conversations are sent
    this.syncedSessions.add(claudeSessionId);
  }

  /**
   * Split messages into separate conversations by /clear command
   * Each /clear command starts a new conversation
   */
  private splitConversationsByClear(messages: ClaudeMessage[]): ClaudeMessage[][] {
    const conversations: ClaudeMessage[][] = [];
    let currentConversation: ClaudeMessage[] = [];

    for (const msg of messages) {
      // Check if this is a user message with /clear command
      if (this.isClearCommand(msg)) {
        // Save current conversation if it has messages
        if (currentConversation.length > 0) {
          conversations.push(currentConversation);
          currentConversation = [];
        }
        // Skip the /clear message itself
        continue;
      }

      // Add message to current conversation
      currentConversation.push(msg);
    }

    // Add final conversation if it has messages
    if (currentConversation.length > 0) {
      conversations.push(currentConversation);
    }

    return conversations;
  }

  /**
   * Check if message is a /clear command
   * Format: <command-name>/clear</command-name>
   */
  private isClearCommand(msg: ClaudeMessage): boolean {
    if (msg.type !== 'user') return false;

    const content = msg.message?.content;

    // Check string content for XML format
    if (typeof content === 'string') {
      return content.includes('<command-name>/clear</command-name>');
    }

    // Check array content (look for text items with XML format)
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === 'text' && item.text?.includes('<command-name>/clear</command-name>')) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Extract session ID from file path
   */
  private extractSessionId(filePath: string): string | null {
    const filename = filePath.split(/[\\/]/).pop();
    if (!filename) return null;

    const sessionId = filename.replace('.jsonl', '');
    return sessionId;
  }

  /**
   * Load synced sessions from disk
   */
  private async loadSyncedSessions(): Promise<void> {
    try {
      if (existsSync(this.syncedSessionsPath)) {
        const content = await readFile(this.syncedSessionsPath, 'utf-8');
        const data = JSON.parse(content);
        this.syncedSessions = new Set(data.sessions || []);
        logger.debug(`[${this.name}] Loaded ${this.syncedSessions.size} synced sessions`);
      }
    } catch (error) {
      logger.warn(`[${this.name}] Failed to load synced sessions:`, error);
      this.syncedSessions = new Set();
    }
  }

  /**
   * Save synced sessions to disk
   */
  private async saveSyncedSessions(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = dirname(this.syncedSessionsPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      // Write to file
      const data = {
        sessions: Array.from(this.syncedSessions),
        lastUpdated: new Date().toISOString()
      };

      await writeFile(this.syncedSessionsPath, JSON.stringify(data, null, 2), 'utf-8');
      logger.debug(`[${this.name}] Saved ${this.syncedSessions.size} synced sessions`);
    } catch (error) {
      logger.warn(`[${this.name}] Failed to save synced sessions:`, error);
    }
  }
}
