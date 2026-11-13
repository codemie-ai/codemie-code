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
import { SyncStoppedError, type SyncBounds } from '@/agents/core/session/BaseProcessor.js';
import { backoffWithin, boundedRequest, noteAuthFailure, throwIfStopped } from '../../bounded-request.js';
import { clearAnalyticsAuthStatus } from '@/utils/analytics-auth-status.js';
import { markAuthInvalidUnlessSuperseded } from '../../analytics-auth-marker.js';

/**
 * A 2xx HTML page where JSON was expected: fetch follows the redirect of an expired session, so the SSO login page
 * lands as a 2xx. An HTML 4xx / 5xx is a proxy's or WAF's own error page (413, a 403 block page, a 502), a failing
 * server's answer, not rejected credentials.
 */
function isLoginPage(response: Response): boolean {
  return response.headers.get('content-type')?.includes('text/html') === true && response.ok;
}

/**
 * Conversation API Client interface
 */
export interface ConversationApiClient {
  upsertConversation(
    conversationId: string,
    history: CodemieHistoryEntry[],
    assistantId?: string,
    folder?: string,
    llmModel?: string
  ): Promise<ConversationSyncResponse>;
}

/**
 * Create a conversation API client instance
 * @param config - API configuration
 * @returns ConversationApiClient instance
 */
export function createApiClient(config: ConversationApiConfig): ConversationApiClient {
  // Private state (closure)
  const bounds: SyncBounds = { deadlineMs: config.deadlineMs, abortSignal: config.abortSignal };
  const apiConfig: Required<Omit<ConversationApiConfig, 'deadlineMs' | 'abortSignal' | 'credentialsSuperseded'>> = {
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
   * Check if HTTP status code should NOT trigger retry
   */
  function isNonRetryableError(statusCode: number): boolean {
    return NON_RETRYABLE_HTTP_CODES.includes(statusCode as any);
  }

  /** The server rejected the credentials: the attempt is not counted and analytics auth waits for a re-login. */
  async function rejectCredentials(signal: AbortSignal | undefined, reason: string): Promise<void> {
    noteAuthFailure(signal);
    await markAuthInvalidUnlessSuperseded({
      reason,
      baseUrl: apiConfig.baseUrl,
      cookies: apiConfig.cookies,
      apiKey: apiConfig.apiKey,
      credentialsSuperseded: config.credentialsSuperseded
    });
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
      folder: string = DEFAULT_CONVERSATION_FOLDER,
      llmModel?: string
    ): Promise<ConversationSyncResponse> {
      // Throws SyncStoppedError when the caller's abort or deadline stops it (the payload stays pending)
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
          assistantId,
          folder,
          llmModel
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
        throwIfStopped(bounds);
        try {
          const request = boundedRequest(apiConfig.timeout, bounds);

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

          let response: Response;
          let body: unknown;
          try {
            response = await fetch(url, {
              method: 'PUT',
              headers,
              body: JSON.stringify(payload),
              signal: request.signal
            });
            body = response.ok && !isLoginPage(response) ? await response.json() : await response.text();
          } catch (error) {
            request.noteOutcome(error);
            const stopReason = request.stopReason();
            throw stopReason ? new SyncStoppedError(stopReason) : error;
          } finally {
            request.dispose();
          }

          if (isLoginPage(response)) {
            const message = `API answered ${response.status} with an HTML page (an SSO login page) instead of JSON`;
            request.noteAnswer(response.status, false, false);
            await rejectCredentials(bounds.abortSignal, message);
            logger.error(`[ConversationApiClient] ${message}`);
            return { success: false, message };
          }

          if (!response.ok) {
            const errorText = body as string;
            let errorData;
            let bodyIsJson = true;

            try {
              errorData = JSON.parse(errorText);
            } catch {
              bodyIsJson = false;
              errorData = { message: errorText };
            }
            request.noteAnswer(response.status, bodyIsJson, false);

            const apiMessage = errorData?.error?.message
              || errorData?.message
              || response.statusText;
            const apiDetails = errorData?.error?.details
              || errorData?.details;
            const message = `API error: ${response.status} ${apiMessage}${apiDetails ? ` (${apiDetails})` : ''}`;
            if (response.status === 401) {
              await rejectCredentials(bounds.abortSignal, message);
            }

            // Check for non-retryable errors
            if (isNonRetryableError(response.status)) {
              logger.error(`[ConversationApiClient] Non-retryable error (${response.status}):`, errorData);
              return {
                success: false,
                message
              };
            }

            // Retryable error - throw to retry
            throw new Error(message);
          }

          // Success
          request.noteAnswer(response.status, true, true);
          const data = body as {
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
          // Server accepted our credentials — clear any stale invalid-auth marker
          await clearAnalyticsAuthStatus();

          if (llmModel?.trim()) {
            const metadataResult = await updateConversationMetadata(conversationId, {
              llm_model: llmModel
            });

            if (!metadataResult.success) {
              logger.warn('[ConversationApiClient] Conversation metadata update failed after history sync', {
                conversationId,
                message: metadataResult.message
              });
            }
          }

          return {
            success: true,
            message: 'Conversation synced successfully',
            conversation_id: data.conversation_id,
            new_messages: data.new_messages,
            total_messages: data.total_messages,
            created: data.created
          };

        } catch (error: any) {
          if (error instanceof SyncStoppedError) {
            logger.info(`[ConversationApiClient] Stopped (${error.reason}) at attempt ${attempt + 1}; the payload stays pending`);
            throw error;
          }
          lastError = error;

          // Log retry attempt
          if (attempt < apiConfig.retryAttempts - 1) {
            const delay = getRetryDelay(attempt);
            logger.warn(`[ConversationApiClient] Sync failed (attempt ${attempt + 1}/${apiConfig.retryAttempts}), retrying in ${delay}ms:`, error.message);
            await backoffWithin(delay, bounds);
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

  async function updateConversationMetadata(
    conversationId: string,
    metadata: { llm_model?: string }
  ): Promise<ConversationSyncResponse> {
    const url = `${apiConfig.baseUrl}/v1/conversations/${conversationId}`;

    if (apiConfig.dryRun) {
      logger.info('[ConversationApiClient] DRY-RUN: Would update conversation metadata', {
        url,
        conversationId,
        metadata
      });
      return {
        success: true,
        message: '[DRY-RUN] Conversation metadata logged (not sent)',
        conversation_id: conversationId
      };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-CodeMie-CLI': `${apiConfig.clientType}/${apiConfig.version}`,
      'X-CodeMie-Client': apiConfig.clientType
    };

    if (apiConfig.apiKey) {
      headers['user-id'] = apiConfig.apiKey;
    } else if (apiConfig.cookies) {
      headers['Cookie'] = apiConfig.cookies;
    }

    throwIfStopped(bounds);
    try {
      const request = boundedRequest(apiConfig.timeout, bounds);
      let response: Response;
      let errorText = '';
      try {
        response = await fetch(url, {
          method: 'PUT',
          headers,
          body: JSON.stringify(metadata),
          signal: request.signal
        });
        if (!response.ok) {
          errorText = await response.text();
        }
      } catch (error) {
        // The delivery ignores this request's failure, so it notes no outcome and never changes what the attempt costs
        const stopReason = request.stopReason();
        throw stopReason ? new SyncStoppedError(stopReason) : error;
      } finally {
        request.dispose();
      }

      if (!response.ok) {
        let errorData;

        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { message: errorText };
        }

        const apiMessage = errorData?.error?.message
          || errorData?.message
          || response.statusText;
        const apiDetails = errorData?.error?.details
          || errorData?.details;
        return {
          success: false,
          message: `Metadata update failed: ${response.status} ${apiMessage}${apiDetails ? ` (${apiDetails})` : ''}`
        };
      }

      logger.debug('[ConversationApiClient] Conversation metadata updated successfully', {
        conversationId,
        llmModel: metadata.llm_model
      });

      return {
        success: true,
        message: 'Conversation metadata updated successfully',
        conversation_id: conversationId
      };
    } catch (error: any) {
      if (error instanceof SyncStoppedError) throw error;
      logger.error(`[ConversationApiClient] Metadata update failed for ${conversationId}:`, error.message);
      return {
        success: false,
        message: `Metadata update failed: ${error.message || 'Unknown error'}`
      };
    }
  }
}
