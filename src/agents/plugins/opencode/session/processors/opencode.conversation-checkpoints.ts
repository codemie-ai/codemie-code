/**
 * The watermark of a session's events before `startTime`: earlier runs' turns, numbered over the
 * full session so this run's `history_index` continues theirs.
 *
 * ponytail: a message begun before the record's start is dropped
 */
export function getPriorRunsCheckpoint(
  events: ReadonlyArray<{ kind: string; sourceIndex: number; date: string }>,
  startTime: number | undefined
): { sourceIndex: number; historyIndex: number } {
  let sourceIndex = -1;
  let historyIndex = -1;
  if (startTime === undefined) return { sourceIndex, historyIndex };

  for (const event of events) {
    // An event whose date does not parse is no earlier run's
    if (!(Date.parse(event.date) < startTime)) continue;
    sourceIndex = Math.max(sourceIndex, event.sourceIndex);
    if (event.kind === 'user_prompt') historyIndex += 1;
  }
  return { sourceIndex, historyIndex };
}
