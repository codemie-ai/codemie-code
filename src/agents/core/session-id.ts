/**
 * Shared session-id safety check for OTLP hook adapters.
 *
 * `session_id` is used verbatim as a filename/path segment (parse-state, its lock, subagent
 * discovery, spool files), so an empty value (would collide with every other empty-id session
 * on one shared file) or one carrying a path separator or `..` segment (path traversal) is
 * rejected here, before anything downstream ever reads it.
 */
export function isSafeSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && !/[\\/]|\.\./.test(sessionId);
}
