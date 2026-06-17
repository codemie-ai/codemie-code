/**
 * Utilities for detecting /clear command boundaries in Claude session transcripts.
 *
 * /clear does not create a new session file — it appends a sentinel user message to the
 * existing JSONL transcript. Claude Code fires a real SessionEnd (reason: "clear") + a
 * new SessionStart, so the hook layer correctly splits the session files. The remaining
 * bug is that MetricsProcessor and native-loader receive the full flat transcript and
 * must themselves ignore messages that already belong to a completed sub-session.
 */

/**
 * Returns true when `msg` is the /clear sentinel written by Claude Code.
 *
 * Claude Code encodes slash commands as XML inside the user message content:
 *   string form:  "<command-name>/clear</command-name>"
 *   array form:   [{ type: "text", text: "<command-name>/clear</command-name>" }]
 */
export function isClearMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'user') return false;
  const content = (m.message as Record<string, unknown> | undefined)?.content;
  if (typeof content === 'string') {
    return content.includes('<command-name>/clear</command-name>');
  }
  if (Array.isArray(content)) {
    return content.some(
      (b) =>
        b &&
        typeof b === 'object' &&
        (b as Record<string, unknown>).type === 'text' &&
        typeof (b as Record<string, unknown>).text === 'string' &&
        ((b as Record<string, unknown>).text as string).includes(
          '<command-name>/clear</command-name>'
        )
    );
  }
  return false;
}

/**
 * Splits `messages` at every /clear sentinel into sub-conversation segments.
 * The /clear message itself is excluded from all segments.
 *
 * - No /clear → returns `[[...all messages]]` (one segment, original behaviour).
 * - N /clears → returns N+1 segments (some may be empty if /clear was at the boundary).
 */
export function splitByClear(messages: unknown[]): unknown[][] {
  const segments: unknown[][] = [];
  let current: unknown[] = [];
  for (const msg of messages) {
    if (isClearMessage(msg)) {
      segments.push(current);
      current = [];
    } else {
      current.push(msg);
    }
  }
  segments.push(current);
  return segments;
}
