/**
 * Conversation API Client (Factory Pattern)
 *
 * Sends conversation history to Codemie API
 * Uses SSO cookie authentication
 * Supports retry with exponential backoff
 */

import type {
  ConversationApiConfig,
  ConversationSyncResponse,
  CodemieHistoryEntry
} from './types.js';
import { logger } from '@/utils/logger.js';
import {
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_CONVERSATION_FOLDER,
  NON_RETRYABLE_HTTP_CODES,
  RETRY_DELAY_MS
} from './constants.js';

/**
 * Conversation API Client interface
 */
export interface ConversationApiClient {
  upsertConversation(
    conversationId: string,
    history: CodemieHistoryEntry[],
    assistantId?: string,
    folder?: string
  ): Promise<ConversationSyncResponse>;
}

/**
 * Create a conversation API client instance
 * @param config - API configuration
 * @returns ConversationApiClient instance
 */
export function createApiClient(config: ConversationApiConfig): ConversationApiClient {
  // Private state (closure)
  const apiConfig: Required<ConversationApiConfig> = {
    baseUrl: config.baseUrl,
    cookies: config.cookies || '',
    apiKey: config.apiKey || '',
    timeout: config.timeout || DEFAULT_API_TIMEOUT_MS,
    retryAttempts: config.retryAttempts || DEFAULT_RETRY_ATTEMPTS,
    version: config.version || '0.0.0',
    clientType: config.clientType || 'codemie-cli',
    dryRun: config.dryRun || false
  };

  // Private helper functions

  /**
   * Get retry delay with exponential backoff
   */
  function getRetryDelay(attempt: number): number {
    return RETRY_DELAY_MS[attempt] || RETRY_DELAY_MS[RETRY_DELAY_MS.length - 1];
  }

  /**
   * Sleep utility
   */
  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if HTTP status code should NOT trigger retry
   */
  function isNonRetryableError(statusCode: number): boolean {
    return NON_RETRYABLE_HTTP_CODES.includes(statusCode as any);
  }

  // Public interface
  return {
    /**
     * Upsert conversation history via API
     * PUT /v1/conversations/{conversation_id}/history
     */
    async upsertConversation(
      conversationId: string,
      history: CodemieHistoryEntry[],
      assistantId: string = 'claude-code-import',
      folder: string = DEFAULT_CONVERSATION_FOLDER
    ): Promise<ConversationSyncResponse> {
      const url = `${apiConfig.baseUrl}/v1/conversations/${conversationId}/history`;

      const payload = {
        assistant_id: assistantId,
        folder,
        history
      };

      // Dry-run mode: Log payload and return success
      if (apiConfig.dryRun) {
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

      for (let attempt = 0; attempt < apiConfig.retryAttempts; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), apiConfig.timeout);

          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-CodeMie-CLI': `${apiConfig.clientType}/${apiConfig.version}`,
            'X-CodeMie-Client': apiConfig.clientType
          };

          // Add authentication headers
          if (apiConfig.apiKey) {
            // Localhost development: user-id header only
            headers['user-id'] = apiConfig.apiKey;
          } else if (apiConfig.cookies) {
            // SSO: Cookie header
            headers['Cookie'] = apiConfig.cookies;
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
            if (isNonRetryableError(response.status)) {
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
          if (attempt < apiConfig.retryAttempts - 1) {
            const delay = getRetryDelay(attempt);
            logger.warn(`[ConversationApiClient] Sync failed (attempt ${attempt + 1}/${apiConfig.retryAttempts}), retrying in ${delay}ms:`, error.message);
            await sleep(delay);
          }
        }
      }

      // All retries failed
      logger.error(`[ConversationApiClient] Sync failed after ${apiConfig.retryAttempts} attempts:`, lastError);
      return {
        success: false,
        message: `Sync failed: ${lastError?.message || 'Unknown error'}`
      };
    }
  };
}
