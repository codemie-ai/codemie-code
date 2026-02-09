/**
 * Chat Command Types
 */

import type { HistoryMessage } from '../constants.js';

/**
 * Chat command options from CLI
 */
export interface ChatCommandOptions {
  verbose?: boolean;
  conversationId?: string;
  loadHistory?: boolean;
}

/**
 * Single message options
 */
export interface SingleMessageOptions {
  quiet?: boolean;
}

/**
 * Message send request
 */
export interface MessageSendRequest {
  message: string;
  history: HistoryMessage[];
  conversationId?: string;
}
