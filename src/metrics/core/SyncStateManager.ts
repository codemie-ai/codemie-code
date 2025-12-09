/**
 * Sync State Manager
 *
 * Manages sync state embedded in session metadata file.
 * Tracks which records have been synced to prevent duplicates.
 * Sync state is stored in: ~/.codemie/metrics/sessions/{sessionId}.json
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import type { SyncState, MetricsSession } from '../types.js';
import { logger } from '../../utils/logger.js';
import { getSessionPath } from '../config.js';

export class SyncStateManager {
  private readonly sessionId: string;
  private readonly filePath: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.filePath = getSessionPath(sessionId);
  }

  /**
   * Initialize new sync state (embedded in session file)
   */
  async initialize(sessionId: string, agentSessionId: string, sessionStartTime: number): Promise<SyncState> {
    try {
      // Check if session exists and already has sync state
      if (existsSync(this.filePath)) {
        const session = await this.loadSession();
        if (session.syncState) {
          logger.debug('[SyncStateManager] Sync state already exists, loading...');
          return session.syncState;
        }
      }

      // Create new sync state
      const syncState: SyncState = {
        sessionId,
        agentSessionId,
        sessionStartTime,
        status: 'active',
        lastProcessedLine: 0,
        lastProcessedTimestamp: Date.now(),
        processedRecordIds: [],
        totalDeltas: 0,
        totalSynced: 0,
        totalFailed: 0
      };

      // Save to session file
      await this.save(syncState);

      logger.info('[SyncStateManager] Initialized new sync state');
      return syncState;

    } catch (error) {
      logger.error('[SyncStateManager] Failed to initialize sync state:', error);
      throw error;
    }
  }

  /**
   * Load session file
   */
  private async loadSession(): Promise<MetricsSession> {
    if (!existsSync(this.filePath)) {
      throw new Error(`Session file does not exist: ${this.filePath}`);
    }

    const content = await readFile(this.filePath, 'utf-8');
    return JSON.parse(content) as MetricsSession;
  }

  /**
   * Load sync state from session file
   */
  async load(): Promise<SyncState> {
    try {
      const session = await this.loadSession();

      if (!session.syncState) {
        throw new Error('Sync state not found in session file');
      }

      logger.debug(`[SyncStateManager] Loaded sync state: ${session.syncState.totalDeltas} deltas, ${session.syncState.totalSynced} synced`);
      return session.syncState;

    } catch (error) {
      logger.error('[SyncStateManager] Failed to load sync state:', error);
      throw error;
    }
  }

  /**
   * Save sync state to session file (atomic write)
   */
  async save(state: SyncState): Promise<void> {
    try {
      // Load current session
      const session = await this.loadSession();

      // Update sync state
      session.syncState = state;

      // Ensure directory exists
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      // Write to temp file first (atomic write)
      const tempFile = `${tmpdir()}/session_${randomUUID()}.json`;
      await writeFile(tempFile, JSON.stringify(session, null, 2), 'utf-8');

      // Rename to final location (atomic operation)
      await rename(tempFile, this.filePath);

      logger.debug('[SyncStateManager] Saved sync state');

    } catch (error) {
      logger.error('[SyncStateManager] Failed to save sync state:', error);
      throw error;
    }
  }

  /**
   * Update last processed line
   */
  async updateLastProcessed(line: number, timestamp: number): Promise<void> {
    try {
      const state = await this.load();

      state.lastProcessedLine = line;
      state.lastProcessedTimestamp = timestamp;

      await this.save(state);

      logger.debug(`[SyncStateManager] Updated last processed line: ${line}`);

    } catch (error) {
      logger.error('[SyncStateManager] Failed to update last processed line:', error);
      throw error;
    }
  }

  /**
   * Add processed record IDs to tracking
   */
  async addProcessedRecords(recordIds: string[]): Promise<void> {
    try {
      const state = await this.load();

      // Add to processed records list
      state.processedRecordIds.push(...recordIds);

      await this.save(state);

      logger.debug(`[SyncStateManager] Added ${recordIds.length} processed record IDs`);

    } catch (error) {
      logger.error('[SyncStateManager] Failed to add processed records:', error);
      throw error;
    }
  }

  /**
   * Mark records as synced
   * Note: Sync status is tracked in metrics JSONL (syncStatus field)
   * This only updates aggregate statistics and last sync info
   */
  async markSynced(recordIds: string[]): Promise<void> {
    try {
      const state = await this.load();

      // Update last synced record (for resume capability)
      if (recordIds.length > 0) {
        state.lastSyncedRecordId = recordIds[recordIds.length - 1];
        state.lastSyncAt = Date.now();
      }

      // Update statistics
      state.totalSynced += recordIds.length;

      await this.save(state);

      logger.debug(`[SyncStateManager] Marked ${recordIds.length} records as synced`);

    } catch (error) {
      logger.error('[SyncStateManager] Failed to mark records as synced:', error);
      throw error;
    }
  }

  /**
   * Increment delta count
   */
  async incrementDeltas(count: number): Promise<void> {
    try {
      const state = await this.load();
      state.totalDeltas += count;
      await this.save(state);

      logger.debug(`[SyncStateManager] Incremented delta count by ${count}`);

    } catch (error) {
      logger.error('[SyncStateManager] Failed to increment deltas:', error);
      throw error;
    }
  }

  /**
   * Increment failed count
   */
  async incrementFailed(count: number): Promise<void> {
    try {
      const state = await this.load();
      state.totalFailed += count;
      await this.save(state);

      logger.debug(`[SyncStateManager] Incremented failed count by ${count}`);

    } catch (error) {
      logger.error('[SyncStateManager] Failed to increment failed count:', error);
      throw error;
    }
  }

  /**
   * Update session status
   */
  async updateStatus(status: 'active' | 'completed' | 'failed', endTime?: number): Promise<void> {
    try {
      const state = await this.load();
      state.status = status;

      if (endTime && (status === 'completed' || status === 'failed')) {
        state.sessionEndTime = endTime;
      }

      await this.save(state);

      logger.info(`[SyncStateManager] Updated status to: ${status}`);

    } catch (error) {
      logger.error('[SyncStateManager] Failed to update status:', error);
      throw error;
    }
  }

  /**
   * Get file path
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Check if file exists
   */
  exists(): boolean {
    return existsSync(this.filePath);
  }
}
