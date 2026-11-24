/**
 * Shared filters for Claude Code transcript lines, applied before any counting.
 */

const MESSAGE_TYPES = new Set(['user', 'assistant']);

function isObject(line: unknown): line is Record<string, unknown> {
  return typeof line === 'object' && line !== null;
}

/** False for a line carrying `message` under a type other than `user` / `assistant` — e.g. Claude Code 2.1.300+ `api-request-blob` copies of real lines. */
export function isCountedTranscriptLine(line: unknown): boolean {
  if (!isObject(line) || !('message' in line)) return true;
  return typeof line.type !== 'string' || MESSAGE_TYPES.has(line.type);
}

/** Drops `user` / `assistant` lines whose `uuid` was already seen, keeping the first copy — Claude Desktop re-writes head lines with the same `uuid` after `/compact`. */
export function keepFirstByUuid<T>(lines: T[], seen: Set<string> = new Set()): T[] {
  return lines.filter((line) => {
    if (!isObject(line) || typeof line.type !== 'string' || !MESSAGE_TYPES.has(line.type)) return true;
    if (typeof line.uuid !== 'string') return true;
    if (seen.has(line.uuid)) return false;
    seen.add(line.uuid);
    return true;
  });
}

/** Keeps one copy per duplicated `uuid`: the first when a `compact_boundary` lies between the copies (Claude Desktop re-writes head lines after `/compact`), else the last (an init re-write is the real turn start). */
export function keepFirstAcrossCompaction<T>(lines: T[]): T[] {
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  const boundaries: number[] = [];
  lines.forEach((line, index) => {
    if (!isObject(line)) return;
    if (line.type === 'system' && line.subtype === 'compact_boundary') boundaries.push(index);
    if (typeof line.uuid !== 'string') return;
    if (!first.has(line.uuid)) first.set(line.uuid, index);
    last.set(line.uuid, index);
  });
  return lines.filter((line, index) => {
    if (!isObject(line) || typeof line.uuid !== 'string') return true;
    const firstIndex = first.get(line.uuid)!;
    const lastIndex = last.get(line.uuid)!;
    if (firstIndex === lastIndex) return true;
    const compacted = boundaries.some((b) => b > firstIndex && b < lastIndex);
    return index === (compacted ? firstIndex : lastIndex);
  });
}
