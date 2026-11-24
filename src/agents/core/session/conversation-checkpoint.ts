import type { ConversationsSyncState } from './types.js';

/**
 * The persisted synced `history_index` of one conversation: its entry in the per-conversation map; a
 * record written before the map carries a single value, which applies only to the conversation it names.
 */
export function persistedHistoryIndexOf(state: ConversationsSyncState | undefined, conversationId: string): number {
  if (state?.historyIndexByConversation) return state.historyIndexByConversation[conversationId] ?? -1;
  return state?.conversationId === conversationId ? state.lastSyncedHistoryIndex ?? -1 : -1;
}
