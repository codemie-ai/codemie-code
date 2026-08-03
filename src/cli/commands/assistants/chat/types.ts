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
  file?: string[];
  jwtToken?: string;
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

export interface DetectedFile {
  fileName: string;
  data: string;
  mediaType: string;
  type: 'image' | 'document';
  sizeBytes: number;
}

export interface UploadsDetector {
  detectFromSession(
    conversationId: string,
    options?: { quiet?: boolean }
  ): Promise<DetectedFile[]>;
}
