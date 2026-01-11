/**
 * Conversation Payload Writer
 *
 * Handles incremental conversation payload storage in JSONL format for debugging.
 * Stores payloads in: ~/.codemie/conversations/sessions/{sessionId}_conversation.jsonl
 *
 * Each line contains:
 * - Timestamp of sync attempt
 * - Whether it's a turn continuation
 * - History indices being synced
 * - The exact payload sent to API
 * - Response status (success/failure)
 * - Error message (if failed)
 */

import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../../../../../utils/logger.js';
import { getSessionConversationPath } from './conversations-config.js';
import { createErrorContext, formatErrorForLog } from '../../../../../../utils/errors.js';

/**
 * Conversation payload record stored in JSONL
 */
export interface ConversationPayloadRecord {
  /** Timestamp when sync was attempted */
  timestamp: number;

  /** Whether this was a turn continuation */
  isTurnContinuation: boolean;

  /** History indices being synced */
  historyIndices: number[];

  /** Number of messages in payload */
  messageCount: number;

  /** The exact payload sent to API */
  payload: {
    conversationId: string;
    history: any[];
  };

  /** Sync result status */
  status: 'pending' | 'success' | 'failed';

  /** Error message if failed */
  error?: string;

  /** Response metadata (if available) */
  response?: {
    statusCode?: number;
    syncedCount?: number;
  };
}

export class ConversationPayloadWriter {
  private readonly filePath: string;
  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.filePath = getSessionConversationPath(sessionId);
  }

  /**
   * Append new payload record to JSONL file (O(1) operation)
   */
  async appendPayload(
    payload: {
      conversationId: string;
      history: any[];
    },
    metadata: {
      isTurnContinuation: boolean;
      historyIndices: number[];
    }
  ): Promise<void> {
    try {
      // Ensure directory exists
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      // Create payload record
      const record: ConversationPayloadRecord = {
        timestamp: Date.now(),
        isTurnContinuation: metadata.isTurnContinuation,
        historyIndices: metadata.historyIndices,
        messageCount: payload.history.length,
        payload,
        status: 'pending'
      };

      // Append to JSONL
      const line = JSON.stringify(record) + '\n';
      await appendFile(this.filePath, line, 'utf-8');

      logger.debug(
        `[ConversationPayloadWriter] Appended payload: conversationId=${payload.conversationId}, ` +
        `messages=${payload.history.length}, indices=${metadata.historyIndices.join(',')}, ` +
        `turnContinuation=${metadata.isTurnContinuation}`
      );

    } catch (error) {
      const errorContext = createErrorContext(error);
      logger.error('[ConversationPayloadWriter] Failed to append payload', formatErrorForLog(errorContext));
      // Don't throw - payload writing is for debugging, shouldn't break sync
    }
  }

  /**
   * Update last payload with sync result
   */
  async updateLastPayloadStatus(
    status: 'success' | 'failed',
    error?: string,
    response?: { statusCode?: number; syncedCount?: number }
  ): Promise<void> {
    try {
      // Read all records
      const records = await this.readAll();
      if (records.length === 0) {
        logger.warn('[ConversationPayloadWriter] No records to update');
        return;
      }

      // Update last record
      const lastRecord = records[records.length - 1];
      lastRecord.status = status;
      if (error) lastRecord.error = error;
      if (response) lastRecord.response = response;

      // Rewrite file
      const content = records
        .map(record => JSON.stringify(record))
        .join('\n') + '\n';

      await appendFile(this.filePath, '', 'utf-8'); // Ensure file exists
      const { writeFile } = await import('fs/promises');
      await writeFile(this.filePath, content, 'utf-8');

      logger.debug(`[ConversationPayloadWriter] Updated last payload status: ${status}`);

    } catch (error) {
      const errorContext = createErrorContext(error);
      logger.error('[ConversationPayloadWriter] Failed to update payload status', formatErrorForLog(errorContext));
      // Don't throw - payload writing is for debugging
    }
  }

  /**
   * Read all payload records from JSONL file
   */
  async readAll(): Promise<ConversationPayloadRecord[]> {
    try {
      if (!existsSync(this.filePath)) {
        return [];
      }

      const content = await readFile(this.filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);

      return lines.map(line => JSON.parse(line) as ConversationPayloadRecord);

    } catch (error) {
      const errorContext = createErrorContext(error);
      logger.error('[ConversationPayloadWriter] Failed to read payloads', formatErrorForLog(errorContext));
      return [];
    }
  }

  /**
   * Get sync statistics
   */
  async getSyncStats(): Promise<{
    total: number;
    pending: number;
    success: number;
    failed: number;
  }> {
    try {
      const records = await this.readAll();

      const stats = {
        total: records.length,
        pending: 0,
        success: 0,
        failed: 0
      };

      for (const record of records) {
        stats[record.status]++;
      }

      return stats;

    } catch (error) {
      const errorContext = createErrorContext(error);
      logger.error('[ConversationPayloadWriter] Failed to get sync stats', formatErrorForLog(errorContext));
      return { total: 0, pending: 0, success: 0, failed: 0 };
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
