/**
 * Conversations Sync Configuration
 *
 * Configuration for conversation payload storage and debugging.
 * All session data consolidated under ~/.codemie/sessions/
 */

import { join } from 'path';
import { getCodemieHome } from '../../../../../../utils/paths.js';

/**
 * Storage paths
 * All session data consolidated under ~/.codemie/sessions/
 */
export const CONVERSATIONS_PATHS = {
  root: '.codemie/sessions',
  sessions: '' // Empty string - sessions are directly in root
};

/**
 * Get full path for conversations storage
 * Base: ~/.codemie/sessions/
 */
export function getConversationsPath(subpath?: string): string {
  const base = join(getCodemieHome(), 'sessions');
  return subpath ? join(base, subpath) : base;
}

/**
 * Get session conversation payloads JSONL file path
 * Format: ~/.codemie/sessions/{sessionId}_conversation.jsonl
 */
export function getSessionConversationPath(sessionId: string): string {
  return join(getCodemieHome(), 'sessions', `${sessionId}_conversation.jsonl`);
}
