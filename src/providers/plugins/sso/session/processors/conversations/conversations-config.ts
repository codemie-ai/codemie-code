/**
 * Conversations Sync Configuration
 *
 * Configuration for conversation payload storage and debugging.
 */

import { join } from 'path';
import { getCodemieHome } from '../../../../../../utils/paths.js';

/**
 * Storage paths
 */
export const CONVERSATIONS_PATHS = {
  root: '.codemie/conversations',
  sessions: 'sessions'
};

/**
 * Get full path for conversations storage
 */
export function getConversationsPath(subpath?: string): string {
  const base = join(getCodemieHome(), 'conversations');
  return subpath ? join(base, subpath) : base;
}

/**
 * Get session conversation payloads JSONL file path
 * Format: ~/.codemie/conversations/sessions/{sessionId}_conversation.jsonl
 */
export function getSessionConversationPath(sessionId: string): string {
  return getConversationsPath(`${CONVERSATIONS_PATHS.sessions}/${sessionId}_conversation.jsonl`);
}
