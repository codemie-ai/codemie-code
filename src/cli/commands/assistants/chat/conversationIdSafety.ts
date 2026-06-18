/**
 * Conversation ID safety guard.
 *
 * The id is interpolated into a filesystem path by
 * `getSessionConversationPath(id)` → `~/.codemie/sessions/<id>_conversation.jsonl`.
 * Anything containing `/`, `..`, NULs, or other path-control characters could
 * either escape the intended sessions directory (read side) or write files
 * outside it (write side, added by `historyPersister.ts`).
 *
 * Allowed: ASCII letters, digits, hyphen, underscore. Length 1..128.
 * That covers UUIDs (which use `[0-9a-f-]`), our generator's workflow id
 * pattern (`<slug>-YYYYMMDD-HHMMSS-PID`), and slug-style identifiers, while
 * rejecting any path-traversal payload.
 */
const SAFE_CONVERSATION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function isValidConversationId(id: string): boolean {
  return SAFE_CONVERSATION_ID.test(id);
}
