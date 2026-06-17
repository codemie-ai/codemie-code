const CLEAR_MARKER = '<command-name>/clear</command-name>';

/**
 * Returns `messages` with everything up to and including the last /clear sentinel removed.
 *
 * Claude Code writes the /clear sentinel into the NEW session file it creates on /clear — not the
 * old one. So the sentinel is always the first meaningful entry in a post-/clear transcript. This
 * function strips it (and any metadata before it) so it is never mistaken for a real user prompt.
 *
 * - No /clear → returns the original array unchanged.
 * - /clear present → returns only messages that follow the last sentinel.
 */
export function trimByClear(messages: unknown[]): unknown[] {
  let start = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    if (r.type !== 'user') continue;
    const content = (r.message as Record<string, unknown> | undefined)?.content;
    const isClear =
      (typeof content === 'string' && content.includes(CLEAR_MARKER)) ||
      (Array.isArray(content) &&
        content.some(
          (b) =>
            b &&
            typeof b === 'object' &&
            (b as Record<string, unknown>).type === 'text' &&
            typeof (b as Record<string, unknown>).text === 'string' &&
            ((b as Record<string, unknown>).text as string).includes(CLEAR_MARKER)
        ));
    if (isClear) start = i + 1;
  }
  return start === 0 ? messages : messages.slice(start);
}
