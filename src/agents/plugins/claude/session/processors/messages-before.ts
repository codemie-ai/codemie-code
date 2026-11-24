/**
 * Transcript messages written before `cutoffMs`, in file order.
 *
 * Judged by each line's timestamp, not by its position: on resume Claude Code appends a
 * synthetic line stamped before the cutoff after later-stamped ones. A message without a
 * timestamp goes with the nearest stamped message before it; the lines of one message group
 * (same `message.id`) go with the group's first line.
 */
export function takeMessagesBefore<T extends { timestamp?: string; message?: { id?: string } }>(
  messages: T[],
  cutoffMs: number
): T[] {
  const groupEarlier = new Map<string, boolean>();
  let previousEarlier = true;
  return messages.filter(message => {
    const time = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
    const ownEarlier = Number.isNaN(time) ? previousEarlier : time < cutoffMs;
    previousEarlier = ownEarlier;
    const groupId = message.message?.id;
    if (!groupId) return ownEarlier;
    if (!groupEarlier.has(groupId)) groupEarlier.set(groupId, ownEarlier);
    return groupEarlier.get(groupId)!;
  });
}
