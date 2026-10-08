/**
 * Leading run of transcript messages written before `cutoffMs`.
 *
 * Transcripts are append-only, so the prefix up to the first message stamped at or after
 * the cutoff is exactly what existed at that moment. Messages without a timestamp stay with
 * their neighbours instead of being judged on their own.
 */
export function takeMessagesBefore<T extends { timestamp?: string }>(messages: T[], cutoffMs: number): T[] {
  const firstAfter = messages.findIndex(message => {
    const time = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
    return !Number.isNaN(time) && time >= cutoffMs;
  });
  return firstAfter < 0 ? messages : messages.slice(0, firstAfter);
}
