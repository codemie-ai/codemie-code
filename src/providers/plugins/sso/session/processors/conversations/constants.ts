/**
 * Conversation Sync Constants
 *
 * Centralized configuration values for conversation processing.
 */

// ============================================================================
// API Configuration
// ============================================================================

/** Default timeout for API requests (milliseconds) */
export const DEFAULT_API_TIMEOUT_MS = 30000;

/** Default number of retry attempts for failed API calls */
export const DEFAULT_RETRY_ATTEMPTS = 3;

/** Retry delays for exponential backoff (milliseconds) */
export const RETRY_DELAY_MS = [1000, 2000, 5000] as const;

// ============================================================================
// CodeMie API Configuration
// ============================================================================

/** CodeMie Assistant ID for conversation imports */
export const CODEMIE_ASSISTANT_ID = '5a430368-9e91-4564-be20-989803bf4da2';

/** API endpoint path for conversation history */
export const CONVERSATIONS_API_PATH = 'v1/conversations';

/** Default folder name for imported conversations */
export const DEFAULT_CONVERSATION_FOLDER = 'Claude Imports';

// ============================================================================
// HTTP Status Codes
// ============================================================================

/** HTTP status codes that should NOT trigger retry logic */
export const NON_RETRYABLE_HTTP_CODES = [400, 401, 403] as const;

// ============================================================================
// Processor Configuration
// ============================================================================

/** Priority of conversation sync processor (lower runs first) */
export const CONVERSATION_PROCESSOR_PRIORITY = 2;

/** Processor name identifier for logging and tracking */
export const CONVERSATION_PROCESSOR_NAME = 'conversation-sync';
