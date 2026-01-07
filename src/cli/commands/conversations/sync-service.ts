/**
 * Conversation Sync Service
 *
 * Provides conversation syncing with incremental message tracking.
 * This is a refactored version of the proxy plugin logic that can be
 * used standalone via CLI or in tests.
 *
 * Key improvements:
 * - Tracks conversations, not just sessions
 * - Incremental message tracking (only sync new messages)
 * - Proper state persistence
 * - Testable without proxy
 */

import { readFile, readdir, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { ConversationApiClient } from '../../../providers/plugins/sso/conversations/sync/sso.conversation-api-client.js';
import { transformMessages } from '../../../providers/plugins/sso/conversations/sync/sso.conversation-transformer.js';
import { isConversationSplitter } from '../../../providers/plugins/sso/conversations/sync/sso.message-filters.js';
import type { ClaudeMessage } from '../../../providers/plugins/sso/conversations/sync/sso.conversation-types.js';
import { logger } from '../../../utils/logger.js';

/**
 * Sync state for a single conversation
 */
export interface ConversationSyncState {
  conversationId: string;
  messageCount: number;
  lastMessageTimestamp: string;
  lastSyncedAt: string;
}

/**
 * Sync state for a Claude session (contains multiple conversations)
 */
export interface SessionSyncState {
  claudeSessionId: string;
  conversations: ConversationSyncState[];
  lastUpdatedAt: string;
}

/**
 * Sync result for a single conversation
 */
export interface ConversationSyncResult {
  conversationId: string;
  messageCount: number;
  newMessages: number;
  created: boolean;
  firstMessage?: string;
}

/**
 * Overall sync result for a session
 */
export interface SessionSyncResult {
  claudeSessionId: string;
  conversationsCount: number;
  totalMessages: number;
  newMessages: number;
  skipped: number;
  conversations: ConversationSyncResult[];
}

export interface SyncServiceConfig {
  baseUrl: string;
  cookies?: Record<string, string> | string;
  apiKey?: string; // For localhost development
  dryRun?: boolean;
  verbose?: boolean;
  homeDir?: string; // For testing - override home directory
}

export class ConversationSyncService {
  private apiClient: ConversationApiClient;
  private sessionsDir: string;
  private verbose: boolean;
  private homeDir: string;

  constructor(config: SyncServiceConfig) {
    // Build cookie header (if cookies provided)
    const cookieHeader = config.cookies
      ? typeof config.cookies === 'string'
        ? config.cookies
        : Object.entries(config.cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ')
      : '';

    this.apiClient = new ConversationApiClient({
      baseUrl: config.baseUrl,
      cookies: cookieHeader,
      apiKey: config.apiKey, // For localhost dev
      timeout: 30000,
      retryAttempts: 3,
      clientType: 'codemie-cli',
      dryRun: config.dryRun || false
    });

    this.verbose = config.verbose || false;
    this.homeDir = config.homeDir || homedir();

    // Sessions directory (one file per session, like analytics)
    this.sessionsDir = join(this.homeDir, '.codemie', 'conversations', 'sessions');
  }

  /**
   * Sync a specific Claude session by ID
   */
  async syncSession(
    claudeSessionId: string,
    assistantId: string,
    folder: string
  ): Promise<SessionSyncResult> {
    logger.info(`[ConversationSyncService] Syncing session: ${claudeSessionId}`);

    // 1. Find session file
    const sessionFile = await this.findSessionFile(claudeSessionId);

    if (!sessionFile) {
      throw new Error(`Session file not found for ID: ${claudeSessionId}`);
    }

    // 2. Load sync state for this specific session
    const sessionState = await this.loadSessionState(claudeSessionId);

    // 3. Read and parse session file
    const content = await readFile(sessionFile, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    if (lines.length === 0) {
      throw new Error('Session file is empty');
    }

    // Parse JSONL messages
    const messages: ClaudeMessage[] = [];
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        messages.push(msg);
      } catch (error) {
        logger.warn(`Failed to parse line in ${sessionFile}:`, error);
      }
    }

    if (messages.length === 0) {
      throw new Error('No valid messages found in session file');
    }

    // 4. Split into conversations by /clear command
    const conversations = this.splitConversationsByClear(messages);

    if (conversations.length === 0) {
      throw new Error('No conversations found in session');
    }

    logger.info(`[ConversationSyncService] Found ${conversations.length} conversation(s)`);

    // 5. Sync each conversation with incremental tracking
    const results: ConversationSyncResult[] = [];
    let totalMessages = 0;
    let newMessages = 0;
    let skipped = 0;

    for (let i = 0; i < conversations.length; i++) {
      const conversationMessages = conversations[i];

      // Check if this conversation was already synced
      const existingConv = sessionState?.conversations[i];

      if (existingConv && existingConv.messageCount === conversationMessages.length) {
        // Same number of messages - skip
        logger.info(`[ConversationSyncService] Conversation ${i + 1} unchanged, skipping`);
        skipped++;

        results.push({
          conversationId: existingConv.conversationId,
          messageCount: existingConv.messageCount,
          newMessages: 0,
          created: false
        });

        continue;
      }

      // Determine conversation ID (reuse existing or create new)
      const conversationId = existingConv?.conversationId || randomUUID();
      const isNew = !existingConv;

      // Get only new messages if this is an update
      const messagesToSync = isNew
        ? conversationMessages
        : conversationMessages.slice(existingConv.messageCount);

      if (messagesToSync.length === 0) {
        logger.info(`[ConversationSyncService] No new messages for conversation ${i + 1}`);
        skipped++;
        continue;
      }

      // Transform to Codemie format (pass assistantId and agent name for intermediate thoughts)
      const history = transformMessages(messagesToSync, assistantId, 'Claude Code');

      if (history.length === 0) {
        logger.warn(`[ConversationSyncService] No history after transformation for conversation ${i + 1}`);
        continue;
      }

      if (this.verbose) {
        logger.info(`[ConversationSyncService] Syncing conversation ${i + 1}/${conversations.length}: ${conversationId} (${history.length} messages)`);
      }

      // Send to API
      const response = await this.apiClient.upsertConversation(
        conversationId,
        history,
        assistantId,
        folder
      );

      if (!response.success) {
        throw new Error(`Failed to sync conversation ${i + 1}: ${response.message}`);
      }

      const firstMessage = history.length > 0 && history[0].role === 'User'
        ? history[0].message
        : undefined;

      results.push({
        conversationId,
        messageCount: conversationMessages.length,
        newMessages: response.new_messages || history.length,
        created: response.created || isNew,
        firstMessage
      });

      totalMessages += conversationMessages.length;
      newMessages += response.new_messages || history.length;

      // Update session state
      if (!sessionState) {
        // Create new session state
        const newSessionState: SessionSyncState = {
          claudeSessionId,
          conversations: [],
          lastUpdatedAt: new Date().toISOString()
        };

        const lastMessage = conversationMessages[conversationMessages.length - 1];
        newSessionState.conversations.push({
          conversationId,
          messageCount: conversationMessages.length,
          lastMessageTimestamp: lastMessage.timestamp,
          lastSyncedAt: new Date().toISOString()
        });

        await this.saveSessionState(claudeSessionId, newSessionState);
      } else {
        // Update existing session state
        const lastMessage = conversationMessages[conversationMessages.length - 1];

        if (existingConv) {
          // Update existing conversation
          existingConv.messageCount = conversationMessages.length;
          existingConv.lastMessageTimestamp = lastMessage.timestamp;
          existingConv.lastSyncedAt = new Date().toISOString();
        } else {
          // Add new conversation
          sessionState.conversations.push({
            conversationId,
            messageCount: conversationMessages.length,
            lastMessageTimestamp: lastMessage.timestamp,
            lastSyncedAt: new Date().toISOString()
          });
        }

        sessionState.lastUpdatedAt = new Date().toISOString();
        await this.saveSessionState(claudeSessionId, sessionState);
      }
    }

    return {
      claudeSessionId,
      conversationsCount: results.length, // Only count actually synced conversations
      totalMessages,
      newMessages,
      skipped,
      conversations: results
    };
  }

  /**
   * Find Claude session file by session ID
   */
  private async findSessionFile(sessionId: string): Promise<string | null> {
    const claudeProjectsDir = join(this.homeDir, '.claude', 'projects');

    if (!existsSync(claudeProjectsDir)) {
      throw new Error(`Claude projects directory not found: ${claudeProjectsDir}`);
    }

    // Get all project directories
    const projectDirs = await readdir(claudeProjectsDir, { withFileTypes: true });

    for (const dir of projectDirs) {
      if (dir.isDirectory()) {
        const projectPath = join(claudeProjectsDir, dir.name);
        const files = await readdir(projectPath);

        for (const file of files) {
          // Match {session-id}.jsonl pattern (exclude agent-* files)
          if (file === `${sessionId}.jsonl`) {
            return join(projectPath, file);
          }
        }
      }
    }

    return null;
  }

  /**
   * Split messages into separate conversations by /clear command
   */
  private splitConversationsByClear(messages: ClaudeMessage[]): ClaudeMessage[][] {
    const conversations: ClaudeMessage[][] = [];
    let currentConversation: ClaudeMessage[] = [];

    for (const msg of messages) {
      // Check if this is a conversation splitter command (/clear, /compact, /compress)
      if (isConversationSplitter(msg)) {
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
   * Load sync state for a specific session
   */
  private async loadSessionState(claudeSessionId: string): Promise<SessionSyncState | null> {
    try {
      const sessionFile = join(this.sessionsDir, `${claudeSessionId}.json`);
      if (existsSync(sessionFile)) {
        const content = await readFile(sessionFile, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      logger.warn(`[ConversationSyncService] Failed to load session state for ${claudeSessionId}:`, error);
    }

    return null;
  }

  /**
   * Save sync state for a specific session
   */
  private async saveSessionState(claudeSessionId: string, state: SessionSyncState): Promise<void> {
    try {
      await mkdir(this.sessionsDir, { recursive: true });

      const sessionFile = join(this.sessionsDir, `${claudeSessionId}.json`);
      await writeFile(sessionFile, JSON.stringify(state, null, 2), 'utf-8');

      if (this.verbose) {
        logger.info(`[ConversationSyncService] Session state saved: ${claudeSessionId}`);
      }
    } catch (error) {
      logger.error(`[ConversationSyncService] Failed to save session state for ${claudeSessionId}:`, error);
    }
  }
}
