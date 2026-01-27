/**
 * Conversation API Client
 *
 * Sends conversation history to Codemie API
 * Uses SSO cookie authentication
 * Supports retry with exponential backoff
 */

import type {
  ConversationApiConfig,
  ConversationSyncResponse,
  CodemieHistoryEntry
} from './conversation-types.js';
import { logger } from '../../../../../../utils/logger.js';

export class ConversationApiClient {
  private config: Required<ConversationApiConfig>;

  constructor(config: ConversationApiConfig) {
    this.config = {
      baseUrl: config.baseUrl,
      cookies: config.cookies || '',
      apiKey: config.apiKey || '',
      timeout: config.timeout || 30000,
      retryAttempts: config.retryAttempts || 3,
      version: config.version || '0.0.0',
      clientType: config.clientType || 'codemie-cli',
      dryRun: config.dryRun || false
    };
  }

  /**
   * Upsert conversation history via API
   * PUT /v1/conversations/{conversation_id}/history
   */
  async upsertConversation(
    conversationId: string,
    history: CodemieHistoryEntry[],
    assistantId: string = 'claude-code-import',
    folder: string = 'Claude Imports'
  ): Promise<ConversationSyncResponse> {
    const url = `${this.config.baseUrl}/v1/conversations/${conversationId}/history`;

    const payload = {
      assistant_id: assistantId,
      folder,
      history
    };

    // Dry-run mode: Log payload and return success
    if (this.config.dryRun) {
      logger.info('[ConversationApiClient] DRY-RUN: Would send conversation', {
        url,
        conversationId,
        historyCount: history.length,
        payload: JSON.stringify(payload, null, 2)
      });

      return {
        success: true,
        message: '[DRY-RUN] Conversation logged (not sent)',
        conversation_id: conversationId,
        new_messages: history.length,
        total_messages: history.length,
        created: true
      };
    }

    // Actual API call with retry
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-CodeMie-CLI': `${this.config.clientType}/${this.config.version}`,
          'X-CodeMie-Client': this.config.clientType
        };

        // Add authentication headers
        if (this.config.apiKey) {
          // Localhost development: user-id header only
          headers['user-id'] = this.config.apiKey;
        } else if (this.config.cookies) {
          // SSO: Cookie header
          headers['Cookie'] = this.config.cookies;
        }

        const response = await fetch(url, {
          method: 'PUT',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          let errorData;

          try {
            errorData = JSON.parse(errorText);
          } catch {
            errorData = { message: errorText };
          }

          // Check for non-retryable errors
          if (response.status === 401 || response.status === 403 || response.status === 400) {
            logger.error(`[ConversationApiClient] Non-retryable error (${response.status}):`, errorData);
            return {
              success: false,
              message: `API error: ${response.status} ${errorData.message || response.statusText}`
            };
          }

          // Retryable error - throw to retry
          throw new Error(`API error: ${response.status} ${errorData.message || response.statusText}`);
        }

        // Success
        const data = await response.json() as {
          conversation_id: string;
          new_messages: number;
          total_messages: number;
          created: boolean;
        };
        logger.debug('[ConversationApiClient] Conversation synced successfully', {
          conversationId: data.conversation_id,
          newMessages: data.new_messages,
          totalMessages: data.total_messages,
          created: data.created
        });

        return {
          success: true,
          message: 'Conversation synced successfully',
          conversation_id: data.conversation_id,
          new_messages: data.new_messages,
          total_messages: data.total_messages,
          created: data.created
        };

      } catch (error: any) {
        lastError = error;

        // Log retry attempt
        if (attempt < this.config.retryAttempts - 1) {
          const delay = this.getRetryDelay(attempt);
          logger.warn(`[ConversationApiClient] Sync failed (attempt ${attempt + 1}/${this.config.retryAttempts}), retrying in ${delay}ms:`, error.message);
          await this.sleep(delay);
        }
      }
    }

    // All retries failed
    logger.error(`[ConversationApiClient] Sync failed after ${this.config.retryAttempts} attempts:`, lastError);
    return {
      success: false,
      message: `Sync failed: ${lastError?.message || 'Unknown error'}`
    };
  }

  /**
   * Get retry delay with exponential backoff
   */
  private getRetryDelay(attempt: number): number {
    const delays = [1000, 2000, 5000]; // 1s, 2s, 5s
    return delays[attempt] || delays[delays.length - 1];
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
